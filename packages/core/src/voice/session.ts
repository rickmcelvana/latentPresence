import type { ConversationEvent } from '@latentpresence/protocol';
import type { BackchannelClip } from '../backchannel/clips';
import { BackchannelScheduler, type BackchannelEvent, type BackchannelOptions } from '../backchannel/scheduler';
import type { ConversationMachine } from '../conversation/machine';
import type { PlaybackSink } from '../playback/sink';
import { BargeInGate, type BargeInOptions } from '../reply/barge-in';
import type { Reply, ReplyEvent, ReplyOptions, ReplyOutcome } from '../reply/reply';
import { TURN_SAMPLE_RATE, type TurnDetector, type TurnEvent, type VadFrame } from '../turn/detector';

/**
 * A spoken conversation, wired (P1-T08): microphone frames in, the character's voice out,
 * and every step on the machine's event bus.
 *
 * This is the part that decides *which* of the pieces' outputs count, and it is where the
 * rules the pieces cannot know about each other live:
 *
 * - **Speech during `thinking`** abandons the reply — nothing was audible yet.
 * - **Speech during `speaking`** only feeds the barge-in gate. A turn that ends while the
 *   character is still audible and the gate never committed is ignored: it was a cough, a
 *   "mm-hm", or the character's own voice in the microphone.
 * - **A provisional turn end** (ADR-25) starts the reply at once and holds its audio until
 *   the frames pass `confirmedAt`; `turn-resumed` abandons it and says so on the bus.
 * - **A committed barge-in** interrupts the reply, which knows what was heard, and puts
 *   that on `assistant.interrupted`; the machine asks the sink for the fade.
 * - **A pause that sounds unfinished** may get a backchannel (P1-T09, ADR-28), played into
 *   the same sink outside any reply and faded the moment the user speaks again.
 *
 * No timers and no DOM. Time is the frames' clock, as it is for the detector.
 */

export interface VoiceSessionOptions<R> {
  readonly sessionId: string;
  readonly machine: ConversationMachine;
  readonly detector: TurnDetector<R>;
  /** The same sink the replies play into, so the gate can duck it. */
  readonly sink: PlaybackSink;
  /** A finished turn's speech as text; null or blank when nothing was recognised. */
  readonly transcribe: (recognition: R | null) => Promise<string | null>;
  /** Start answering. Pass `options` through to the `Reply`: they carry the hold and the events. */
  readonly respond: (text: string, options: ReplyOptions) => Reply;
  readonly bargeIn?: BargeInOptions;
  /** Clips to say in the user's pauses, and when. Omitted or empty: the character never backchannels. */
  readonly backchannel?: BackchannelOptions & {
    readonly clips: readonly BackchannelClip[];
    /** Every clip played or cut, for a harness to show. The bus only carries the first. */
    readonly onEvent?: (event: BackchannelEvent) => void;
  };
  /** Barge-in fade. Should match the machine's `fadeOutMs`; 100 by default, as the plan says. */
  readonly fadeMs?: number;
  /** The detector's sample rate, to turn a frame into milliseconds. */
  readonly sampleRate?: number;
  /** Wall clock for event stamps. */
  readonly now?: () => string;
}

/** A user turn that has ended and is being answered. */
interface PendingTurn {
  readonly turnId: number;
  readonly confirmedAt: number;
  confirmed: boolean;
  readonly release: () => void;
  readonly hold: Promise<void>;
  reply: Reply | null;
}

export class VoiceSession<R> {
  readonly gate: BargeInGate;
  readonly backchannels: BackchannelScheduler | null;
  private readonly options: VoiceSessionOptions<R>;
  private readonly fadeMs: number;
  private readonly sampleRate: number;
  private readonly now: () => string;
  private readonly detach: (() => void)[] = [];
  private pending: PendingTurn | null = null;
  /** The reply that is playing or about to, which may outlive its `pending` turn. */
  private reply: Reply | null = null;
  private replies = 0;

  constructor(options: VoiceSessionOptions<R>) {
    this.options = options;
    this.fadeMs = options.fadeMs ?? 100;
    this.sampleRate = options.sampleRate ?? TURN_SAMPLE_RATE;
    this.now = options.now ?? (() => new Date().toISOString());
    this.gate = new BargeInGate(options.bargeIn);
    const backchannel = options.backchannel;
    this.backchannels =
      backchannel === undefined || backchannel.clips.length === 0
        ? null
        : new BackchannelScheduler(options.sink, backchannel.clips, backchannel);
    this.detach.push(options.detector.subscribe((event) => this.onTurn(event)));
    this.detach.push(
      options.machine.subscribe((event) => {
        if (event.type !== 'state.changed') return;
        if (event.to === 'speaking') this.gate.arm();
        else if (event.from === 'speaking' && this.gate.disarm() === 'unduck') options.sink.unduck();
      }),
    );
  }

  /** One microphone frame, with Silero's probability for it. */
  push(frame: VadFrame): void {
    this.options.detector.push(frame);

    const pending = this.pending;
    if (pending !== null && !pending.confirmed && frame.at >= pending.confirmedAt) {
      pending.confirmed = true;
      pending.release();
    }

    const action = this.gate.push(frame.probability, (frame.samples.length / this.sampleRate) * 1000);
    if (action === 'duck') this.options.sink.duck();
    else if (action === 'unduck') this.options.sink.unduck();
    else if (action === 'commit') this.commit();

    const cut = this.backchannels?.push(frame);
    if (cut) this.options.backchannel?.onEvent?.(cut);
  }

  /** Stop listening to the pieces and abandon anything in flight. */
  dispose(): void {
    for (const detach of this.detach.splice(0)) detach();
    this.backchannels?.dispose();
    this.reply?.interrupt(this.fadeMs);
    this.pending = null;
    this.reply = null;
  }

  private onTurn(event: TurnEvent<R>): void {
    const { machine } = this.options;
    const said = this.backchannels?.onTurn(event, machine.getState());
    if (said) {
      this.dispatch({ type: 'assistant.backchannel', text: said.text });
      this.options.backchannel?.onEvent?.(said);
    }
    switch (event.type) {
      case 'speech-start':
        if (machine.getState() === 'thinking') this.abandon();
        this.dispatch({ type: 'user.speech.started' });
        return;
      case 'turn-end':
        // The character is still audible and nobody interrupted it: not a turn.
        if (machine.getState() === 'speaking') return;
        this.dispatch({ type: 'user.speech.ended' });
        this.dispatch({ type: 'user.turn.ended', probability: event.probability });
        this.answer(event.turnId, event.confirmedAt, event.recognition);
        return;
      case 'turn-resumed':
        if (this.pending?.turnId !== event.turnId) return;
        this.abandon();
        this.dispatch({ type: 'user.turn.resumed', pauseMs: Math.max(0, Math.round(event.pauseMs)) });
        return;
      default:
        return;
    }
  }

  private answer(turnId: number, confirmedAt: number, recognition: R | null): void {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending: PendingTurn = { turnId, confirmedAt, confirmed: false, release, hold, reply: null };
    this.pending = pending;

    this.options.transcribe(recognition).then(
      (text) => {
        if (this.pending !== pending) return;
        const said = text?.trim() ?? '';
        if (said === '') {
          this.pending = null;
          this.dispatch({ type: 'error', scope: 'stt', message: 'nothing was recognised' });
          return;
        }
        this.dispatch({ type: 'user.transcript', text: said, isFinal: true, confidence: null });
        this.startReply(pending, said);
      },
      (error: unknown) => {
        if (this.pending !== pending) return;
        this.pending = null;
        this.dispatch({ type: 'error', scope: 'stt', message: error instanceof Error ? error.message : String(error) });
      },
    );
  }

  private startReply(pending: PendingTurn, text: string): void {
    // A previous answer still fading out has already settled; this one replaces it.
    const reply = this.options.respond(text, { hold: pending.hold, onEvent: (event) => this.onReply(reply, event) });
    pending.reply = reply;
    this.reply = reply;
    const id = `${this.options.sessionId}-reply-${(this.replies += 1)}`;
    void reply.done.then((outcome) => this.settled(reply, id, outcome));
  }

  private onReply(reply: Reply, event: ReplyEvent): void {
    if (this.reply !== reply) return;
    switch (event.type) {
      case 'sentence':
        this.dispatch({ type: 'assistant.sentence', text: event.text, index: event.index });
        return;
      case 'audio-started':
        this.dispatch({ type: 'assistant.audio.started', sentenceIndex: event.index });
        return;
      case 'audio-ended':
        this.dispatch({ type: 'assistant.audio.ended', sentenceIndex: event.index });
        return;
    }
  }

  private settled(reply: Reply, id: string, outcome: ReplyOutcome): void {
    if (this.reply === reply) this.reply = null;
    if (this.pending?.reply === reply) this.pending = null;
    const entry = (spokenPrefix: string | null) => ({
      id,
      role: 'assistant' as const,
      text: outcome.text,
      at: this.now(),
      spokenPrefix,
    });
    switch (outcome.status) {
      case 'complete':
        this.dispatch({ type: 'assistant.message', entry: entry(null) });
        return;
      case 'interrupted':
        this.dispatch({ type: 'assistant.message', entry: entry(outcome.spokenPrefix) });
        return;
      case 'abandoned':
        return;
      case 'failed':
        this.dispatch({ type: 'error', scope: outcome.scope, message: outcome.error });
        if (outcome.spokenPrefix !== '') {
          this.dispatch({ type: 'assistant.message', entry: entry(outcome.spokenPrefix) });
        }
        return;
    }
  }

  /** The gate committed: cut the answer at what was heard, and let the machine fade it. */
  private commit(): void {
    const reply = this.reply;
    if (reply === null) return;
    const outcome = reply.interrupt(this.fadeMs);
    if (outcome.status === 'interrupted') {
      this.dispatch({ type: 'assistant.interrupted', spokenPrefix: outcome.spokenPrefix });
    }
  }

  /** Drop the pending turn's answer before anyone heard it. */
  private abandon(): void {
    const pending = this.pending;
    this.pending = null;
    pending?.reply?.interrupt(this.fadeMs);
  }

  private dispatch(event: DistributiveOmit<ConversationEvent, 'sessionId' | 'at'>): void {
    this.options.machine.dispatch({
      ...event,
      sessionId: this.options.sessionId,
      at: this.now(),
    } as ConversationEvent);
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
