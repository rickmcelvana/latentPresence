import type { ConversationEvent, LLMProvider, LlmFinishReason, LlmMessage, TTSProvider } from '@latentpresence/protocol';
import { Cancellation } from '../cancellation';
import { SentenceChunker, TagFilter, type SpeechChunk } from '../chunker';
import { ConversationHistory } from '../history/history';
import type { ConversationMachine } from '../conversation/machine';
import type { PlaybackSink } from '../playback/sink';
import { Reply, type ReplyDependencies, type ReplyEvent, type ReplyOutcome } from '../reply/reply';

/**
 * A typed conversation with no voice in it (P1-T11): text in, a streamed answer out, every
 * step on the machine's bus in the same events a spoken turn uses, so one transcript reads
 * both.
 *
 * - `send` puts `user.message` on the bus and streams the answer as `assistant.token`s,
 *   settling with `assistant.message`. Sending while an answer streams stops that one first.
 * - `stop` cuts the answer where it is. What was already on screen was read, so it settles
 *   like a barge-in: `assistant.interrupted` and an `assistant.message` whose
 *   `spokenPrefix` is the text shown. Stopped before any text, it settles empty.
 * - A model that writes nothing is an `error`, never a blank line: a thinking model can
 *   spend its whole output budget reasoning (P1-T02), and `length` says so.
 *
 * It keeps the conversation so far and sends it with every request — what the user saw of
 * each answer, not what the model meant to say.
 *
 * **Since P1-T12b that history is a shared `ConversationHistory`, not a private array**, so
 * a typed message and a spoken one land in the same place and the model is told exactly
 * what the transcript shows. Pass one in to share it with a `VoiceSession`; left out, the
 * session makes its own and behaves as before. The heard-not-meant rule now lives there,
 * derived from the transcript rather than restated here.
 *
 * **Since P2-T08 an answer can be spoken** (`setVoice`): the typed turn is answered by the
 * same `Reply` a call uses — sentences, tags, audio — so the machine reaches `speaking`, the
 * talk clip plays, the mouth follows the voice and the tag bridge acts on the words. Stop
 * then follows the heard rule a barge-in does, but only once she is audible: stopped before
 * a word was played, the answer settles exactly as a typed one does, as the text shown.
 */

/** What speaking an answer needs (P2-T08). The sink is the character's voice on this page. */
export interface ChatVoice {
  readonly tts: TTSProvider;
  readonly sink: PlaybackSink;
  readonly voiceId: string;
  readonly speed?: number;
  /** How each sentence should sound (P3-T03); passed to `Reply` as it is. */
  readonly voiceStyle?: ReplyDependencies['voiceStyle'];
  /** Stop's fade. Should match the machine's `fadeOutMs`; 100 by default, as barge-in. */
  readonly fadeMs?: number;
}

export interface ChatSessionOptions {
  readonly sessionId: string;
  readonly machine: ConversationMachine;
  readonly llm: LLMProvider;
  readonly modelId: string;
  /** null leaves it to the backend. Never 0 for a thinking model (P1-T10 enforces it). */
  readonly temperature?: number | null;
  readonly maxOutputTokens?: number | null;
  /** Sent first when set. Ignored when `history` is passed: that carries its own `system`. */
  readonly system?: string;
  /**
   * The conversation this session reads and contributes to. Share one with a
   * `VoiceSession` so typing and talking are one conversation (P1-T12b). Omitted: the
   * session keeps its own.
   */
  readonly history?: ConversationHistory;
  /** Speak every answer from the first (P2-T08). Omitted: answers are text until `setVoice`. */
  readonly voice?: ChatVoice | null;
  /** Wall clock for event stamps. */
  readonly now?: () => string;
}

/** The answer streaming now. */
interface Streaming {
  readonly id: string;
  readonly cancellation: Cancellation;
  /** What was shown: tag-free, and the text a stopped answer is remembered by. */
  text: string;
  /** Tags are held back mid-delta, so `text` never briefly contains one (P1-T12). */
  readonly tagFilter: TagFilter;
  /**
   * The same words as sentences, for `assistant.sentence` (P3-T09): a typed answer shown as
   * text still carries `[emote:x]` tags, and the affect engine feels them from the bus. The
   * spoken path gets its sentences from `Reply`.
   */
  readonly sentences: SentenceChunker;
  /** A spoken answer's reply (P2-T08); null for a text one. */
  reply: Reply | null;
  readonly fadeMs: number;
}

export const NO_TEXT_MESSAGE = 'the model produced no text';
export const NO_TEXT_LENGTH_MESSAGE = 'the model used its whole output budget without writing an answer';

export class ChatSession {
  private readonly options: ChatSessionOptions;
  private readonly now: () => string;
  private readonly history: ConversationHistory;
  private streaming: Streaming | null = null;
  private voice: ChatVoice | null;
  private replies = 0;
  private disposed = false;

  constructor(options: ChatSessionOptions) {
    this.options = options;
    this.voice = options.voice ?? null;
    this.now = options.now ?? (() => new Date().toISOString());
    this.history = options.history ?? new ConversationHistory({ system: options.system ?? null });
    // The history watches the bus rather than being written to, so it can never disagree
    // with the transcript the user is reading. Delivery is synchronous, so a message
    // dispatched below is already in `history.messages` on the next line.
    if (options.history === undefined) {
      options.machine.subscribe((event) => this.history.observe(event));
    }
  }

  /** An answer is streaming. */
  get busy(): boolean {
    return this.streaming !== null;
  }

  /** The conversation as it will be sent next, without `system`. */
  get messages(): readonly LlmMessage[] {
    return this.history.messages;
  }

  /** Answers are spoken. */
  get speaking(): boolean {
    return this.voice !== null;
  }

  /**
   * Speak answers from now on, or stop speaking them (null). **An answer in flight is
   * stopped**, as Stop would: its voice belongs to a sink the caller is about to replace or
   * close, and an answer half spoken and half not is neither.
   */
  setVoice(voice: ChatVoice | null): void {
    if (voice === this.voice) return;
    this.stop();
    this.voice = voice;
  }

  /** Send a typed message. Blank text is ignored and returns false. */
  send(text: string): boolean {
    const said = text.trim();
    if (said === '' || this.disposed) return false;
    this.stop();
    // No push: `history` is watching the bus, and this dispatch is delivered synchronously.
    this.dispatch({ type: 'user.message', text: said });
    const streaming: Streaming = {
      id: `${this.options.sessionId}-reply-${(this.replies += 1)}`,
      cancellation: new Cancellation(),
      text: '',
      tagFilter: new TagFilter(),
      sentences: new SentenceChunker(),
      reply: null,
      fadeMs: this.voice?.fadeMs ?? 100,
    };
    this.streaming = streaming;
    if (this.voice === null) void this.run(streaming);
    else this.speak(streaming, this.voice);
    return true;
  }

  /**
   * Cut the streaming answer where it is. Nothing streaming: nothing happens.
   *
   * Spoken and audible, it is a barge-in by button: the voice fades and the answer is
   * remembered as what was heard (`assistant.interrupted` moves the machine through the
   * fade). Not yet audible, it settles as a typed answer does — the text shown was read.
   */
  stop(): void {
    const streaming = this.streaming;
    if (streaming === null) return;
    this.streaming = null;
    streaming.cancellation.abort();
    const outcome = streaming.reply?.interrupt(streaming.fadeMs);
    if (outcome?.status === 'interrupted') {
      this.dispatch({ type: 'assistant.interrupted', spokenPrefix: outcome.spokenPrefix });
      this.dispatch({ type: 'assistant.message', entry: this.entry(streaming, outcome.spokenPrefix, outcome.text) });
      return;
    }
    if (streaming.text !== '') {
      this.dispatch({ type: 'assistant.interrupted', spokenPrefix: streaming.text });
    }
    // Settles the machine back to listening either way; an empty entry is no transcript line.
    this.dispatch({ type: 'assistant.message', entry: this.entry(streaming, streaming.text) });
  }

  /** Stop streaming and ignore every later call. */
  dispose(): void {
    this.stop();
    this.disposed = true;
  }

  private async run(streaming: Streaming): Promise<void> {
    const { llm, modelId } = this.options;
    const request = {
      modelId,
      messages: this.history.request(),
      tools: [],
      temperature: this.options.temperature ?? null,
      maxOutputTokens: this.options.maxOutputTokens ?? null,
    };
    let reason: LlmFinishReason | null = null;
    let failure: string | null = null;
    try {
      for await (const part of llm.stream(request, { signal: streaming.cancellation })) {
        if (this.streaming !== streaming) return;
        if (part.type === 'text-delta' && part.text !== '') {
          const shown = streaming.tagFilter.push(part.text);
          if (shown !== '') {
            streaming.text += shown;
            this.dispatch({ type: 'assistant.token', text: shown });
          }
          this.sentences(streaming.sentences.push(part.text));
        } else if (part.type === 'finish') {
          reason = part.reason;
        }
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    if (this.streaming !== streaming) return;
    this.streaming = null;
    // Held-back text that never became a tag is still the model's words.
    const tail = streaming.tagFilter.flush();
    if (tail !== '') {
      streaming.text += tail;
      this.dispatch({ type: 'assistant.token', text: tail });
    }
    this.sentences(streaming.sentences.flush());

    if (failure === null && reason === 'error') failure = 'the model stream ended with an error';
    if (failure === null && streaming.text === '') {
      failure = reason === 'length' ? NO_TEXT_LENGTH_MESSAGE : NO_TEXT_MESSAGE;
    }
    if (failure !== null) {
      this.dispatch({ type: 'error', scope: 'llm', message: failure });
      if (streaming.text !== '') {
        // Cut short by the failure: keep what was shown, marked as not the whole answer.
        this.dispatch({ type: 'assistant.message', entry: this.entry(streaming, streaming.text) });
      }
      return;
    }
    this.dispatch({ type: 'assistant.message', entry: this.entry(streaming, null) });
  }

  /**
   * A spoken answer (P2-T08): the `Reply` a call's turn gets, with no hold — a typed turn is
   * final the moment it is sent. Its events go on the bus as `VoiceSession` puts them there.
   */
  private speak(streaming: Streaming, voice: ChatVoice): void {
    const { llm, modelId } = this.options;
    const request = {
      modelId,
      messages: this.history.request(),
      tools: [],
      temperature: this.options.temperature ?? null,
      maxOutputTokens: this.options.maxOutputTokens ?? null,
    };
    const reply = new Reply(
      request,
      {
        llm,
        tts: voice.tts,
        sink: voice.sink,
        voiceId: voice.voiceId,
        ...(voice.speed === undefined ? {} : { speed: voice.speed }),
        ...(voice.voiceStyle === undefined ? {} : { voiceStyle: voice.voiceStyle }),
      },
      { onEvent: (event) => this.onReply(streaming, event) },
    );
    streaming.reply = reply;
    void reply.done.then((outcome) => this.settled(streaming, outcome));
  }

  private sentences(chunks: readonly SpeechChunk[]): void {
    for (const chunk of chunks) {
      this.dispatch({ type: 'assistant.sentence', text: chunk.text, index: chunk.index, tags: [...chunk.tags] });
    }
  }

  private onReply(streaming: Streaming, event: ReplyEvent): void {
    if (this.streaming !== streaming) return;
    switch (event.type) {
      case 'token':
        streaming.text += event.text;
        this.dispatch({ type: 'assistant.token', text: event.text });
        return;
      case 'sentence':
        this.dispatch({ type: 'assistant.sentence', text: event.text, index: event.index, tags: [...event.tags] });
        return;
      case 'audio-started':
        this.dispatch({ type: 'assistant.audio.started', sentenceIndex: event.index, timing: event.timing });
        return;
      case 'audio-ended':
        this.dispatch({ type: 'assistant.audio.ended', sentenceIndex: event.index });
        return;
    }
  }

  /** A spoken answer that ended on its own: played out, or failed. `stop` settles the rest. */
  private settled(streaming: Streaming, outcome: ReplyOutcome): void {
    if (this.streaming !== streaming) return;
    this.streaming = null;
    if (outcome.status === 'complete') {
      this.dispatch({ type: 'assistant.message', entry: this.entry(streaming, null, outcome.text) });
      return;
    }
    if (outcome.status !== 'failed') return;
    this.dispatch({ type: 'error', scope: outcome.scope, message: outcome.error });
    // Cut short by the failure. Heard words are what she said; nothing heard, the text
    // shown is, as for a typed answer that failed part way.
    if (outcome.spokenPrefix !== '') {
      this.dispatch({ type: 'assistant.message', entry: this.entry(streaming, outcome.spokenPrefix, outcome.text) });
    } else if (streaming.text !== '') {
      this.dispatch({ type: 'assistant.message', entry: this.entry(streaming, streaming.text) });
    }
  }

  private entry(streaming: Streaming, spokenPrefix: string | null, text: string = streaming.text) {
    return { id: streaming.id, role: 'assistant' as const, text, at: this.now(), spokenPrefix };
  }

  private dispatch(event: DistributiveOmit<ConversationEvent, 'sessionId' | 'at'>): void {
    this.options.machine.dispatch({ ...event, sessionId: this.options.sessionId, at: this.now() } as ConversationEvent);
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
