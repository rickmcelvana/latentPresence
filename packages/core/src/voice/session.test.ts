import { describe, expect, it } from 'vitest';
import type { CancellationSignal, ConversationEvent, LlmRequest, LlmStreamChunk } from '@latentpresence/protocol';
import { ConversationMachine } from '../conversation/machine';
import type { BargeInOptions } from '../reply/barge-in';
import { Reply, type ReplyOutcome } from '../reply/reply';
import { deferred, ManualSink, ScriptedLLM, ScriptedTTS, settle, text } from '../testing/scripted';
import { TurnDetector, type TurnJudge } from '../turn/detector';
import { VoiceSession } from './session';

/**
 * The wiring, end to end with nothing real in it but the logic: scripted Silero
 * probabilities through the real `TurnDetector`, the real machine and real `Reply`s over
 * scripted providers and a sink the test plays by hand (P1-T08).
 */

const AT = '2026-09-13T00:00:00.000Z';
const FRAME = 512;
const FRAME_MS = 32;
const ANSWER = "It is nearly three o'clock.";

const request: LlmRequest = {
  modelId: 'scripted',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [],
  temperature: null,
  maxOutputTokens: null,
};

class Judge implements TurnJudge {
  readonly calls: ((probability: number) => void)[] = [];
  judge(_audio: Float32Array, _signal: CancellationSignal): Promise<number> {
    return new Promise((resolve) => this.calls.push(resolve));
  }
  answer(probability: number): void {
    this.calls.at(-1)?.(probability);
  }
}

function rig(
  options: {
    judge?: Judge;
    transcribe?: () => Promise<string | null>;
    script?: readonly LlmStreamChunk[];
    bargeIn?: BargeInOptions;
  } = {},
) {
  let clock = 0;
  let index = 0;
  const detector = new TurnDetector<string>({
    now: () => clock,
    ...(options.judge === undefined ? {} : { judge: options.judge }),
    recognise: (audio) => `recognition of ${audio.samples.length} samples`,
  });
  const sink = new ManualSink();
  const machine = new ConversationMachine({ sessionId: 's', characterId: 'alice', now: () => AT, ports: { audioOut: sink } });
  const events: ConversationEvent[] = [];
  machine.subscribe((event) => events.push(event));
  const replies: Reply[] = [];
  const outcomes: ReplyOutcome[] = [];
  const session = new VoiceSession<string>({
    sessionId: 's',
    machine,
    detector,
    sink,
    now: () => AT,
    transcribe: options.transcribe ?? (async () => 'what time is it'),
    respond: (_said, replyOptions) => {
      const reply = new Reply(
        request,
        { llm: new ScriptedLLM(options.script ?? text(ANSWER)), tts: new ScriptedTTS(), sink, voiceId: 'v' },
        replyOptions,
      );
      replies.push(reply);
      void reply.done.then((outcome) => outcomes.push(outcome));
      return reply;
    },
    ...(options.bargeIn === undefined ? {} : { bargeIn: options.bargeIn }),
  });
  machine.start();

  return {
    session,
    machine,
    sink,
    replies,
    outcomes,
    /** `count` 32 ms frames at `probability`. */
    frames(count: number, probability: number): void {
      for (let i = 0; i < count; i += 1) {
        const at = index * FRAME_MS;
        clock = at;
        index += 1;
        session.push({ samples: new Float32Array(FRAME), probability, at });
      }
    },
    types: (): string[] => events.map((event) => event.type).filter((type) => type !== 'state.changed'),
    of<T extends ConversationEvent['type']>(type: T): Extract<ConversationEvent, { type: T }>[] {
      return events.filter((event): event is Extract<ConversationEvent, { type: T }> => event.type === type);
    },
    state: () => machine.getState(),
  };
}

/** Speak, go quiet until the hangover ends the turn, and let the answer be synthesised. */
async function turn(r: ReturnType<typeof rig>): Promise<void> {
  r.frames(10, 0.9);
  r.frames(20, 0.05);
  await settle();
}

describe('VoiceSession — a turn and its answer', () => {
  it('turns speech into a transcript, an answer, and back to listening once it has played', async () => {
    const r = rig();
    await turn(r);

    expect(r.types()).toEqual([
      'session.started',
      'user.speech.started',
      'user.speech.ended',
      'user.turn.ended',
      'user.transcript',
      'assistant.sentence',
    ]);
    // The hangover ended it: no probability to report, and nothing to wait for.
    expect(r.of('user.turn.ended')[0]?.probability).toBeNull();
    expect(r.of('user.transcript')[0]?.text).toBe('what time is it');
    expect(r.sink.segments).toHaveLength(1);
    expect(r.state()).toBe('thinking');

    r.sink.start(100);
    expect(r.state()).toBe('speaking');
    r.sink.end(100);
    await settle();

    expect(r.state()).toBe('listening');
    expect(r.of('assistant.message')[0]?.entry).toMatchObject({ text: ANSWER, spokenPrefix: null, role: 'assistant' });
  });

  it('says so when nothing was recognised, and goes back to listening', async () => {
    const r = rig({ transcribe: async () => '  ' });
    await turn(r);
    expect(r.of('error')[0]).toMatchObject({ scope: 'stt', message: 'nothing was recognised' });
    expect(r.replies).toHaveLength(0);
    expect(r.state()).toBe('listening');
  });

  it('reports a failed answer and returns to listening', async () => {
    const r = rig({ script: [{ type: 'finish', reason: 'error', usage: null }] });
    await turn(r);
    expect(r.of('error')[0]).toMatchObject({ scope: 'llm' });
    expect(r.state()).toBe('listening');
  });
});

describe('VoiceSession — provisional turn ends (ADR-25)', () => {
  it('starts the answer at a model end but plays nothing until the turn is confirmed', async () => {
    const judge = new Judge();
    const r = rig({ judge });
    r.frames(10, 0.9);
    r.frames(4, 0.05); // the candidate; speech ended with frame 9, stamped 288 ms
    judge.answer(0.95);
    await settle();

    expect(r.of('user.turn.ended')[0]?.probability).toBe(0.95);
    expect(r.of('assistant.sentence')).toHaveLength(1);
    expect(r.sink.segments).toHaveLength(0);

    // confirmedAt = 288 + 500 = 788 ms: frame 24 is at 768, frame 25 at 800.
    r.frames(11, 0.05);
    await settle();
    expect(r.sink.segments).toHaveLength(0);
    r.frames(2, 0.05);
    await settle();
    expect(r.sink.segments).toHaveLength(1);
  });

  it('abandons the answer when the user carries on, and answers the whole turn afterwards', async () => {
    const judge = new Judge();
    const r = rig({ judge });
    r.frames(10, 0.9);
    r.frames(4, 0.05);
    judge.answer(0.95);
    await settle();
    expect(r.replies).toHaveLength(1);

    r.frames(3, 0.05);
    r.frames(6, 0.9); // "…came in low across the desk."
    await settle();

    expect(r.outcomes[0]).toMatchObject({ status: 'abandoned' });
    expect(r.of('user.turn.resumed')).toHaveLength(1);
    // From the last speech frame (288 ms) to the first frame of speech again (544 ms).
    expect(r.of('user.turn.resumed')[0]?.pauseMs).toBe(8 * FRAME_MS);
    expect(r.state()).toBe('listening');
    expect(r.sink.segments).toHaveLength(0);

    r.frames(20, 0.05);
    await settle();
    expect(r.replies).toHaveLength(2);
    expect(r.sink.segments).toHaveLength(1);
  });

  it('drops a transcription that finishes after the user has started talking again', async () => {
    const late = deferred();
    const r = rig({ transcribe: async () => (await late.promise, 'too late') });
    await turn(r);
    expect(r.state()).toBe('thinking');

    r.frames(2, 0.9); // a new turn begins while the old one is still being recognised
    expect(r.state()).toBe('listening');
    late.resolve();
    await settle();
    expect(r.of('user.transcript')).toHaveLength(0);
    expect(r.replies).toHaveLength(0);
  });

  it('abandons a queued answer nobody has heard yet when the user speaks first', async () => {
    const r = rig();
    await turn(r);
    expect(r.sink.segments).toHaveLength(1);
    r.frames(1, 0.9);
    await settle();
    expect(r.outcomes[0]).toMatchObject({ status: 'abandoned' });
    expect(r.sink.fades).toEqual([100]);
    expect(r.of('assistant.interrupted')).toHaveLength(0);
    expect(r.state()).toBe('listening');
  });
});

describe('VoiceSession — barge-in', () => {
  it('ducks for a cough, lets it go, and never cuts the answer', async () => {
    const r = rig();
    await turn(r);
    r.sink.start(100);

    r.frames(2, 0.9);
    r.frames(4, 0.05);
    expect(r.sink.gain).toEqual(['duck', 'unduck']);
    expect(r.state()).toBe('speaking');
    expect(r.sink.fades).toEqual([]);
  });

  it('ignores a turn that ends while the character is still audible', async () => {
    const r = rig();
    await turn(r);
    r.sink.start(100);
    // Two frames of speech, then enough silence for the hangover to close it.
    r.frames(2, 0.9);
    r.frames(20, 0.05);
    await settle();
    expect(r.of('user.turn.ended')).toHaveLength(1);
    expect(r.replies).toHaveLength(1);
    expect(r.state()).toBe('speaking');
  });

  it('commits after sustained speech: fades, keeps what was heard, and answers the interjection', async () => {
    const r = rig();
    await turn(r);
    r.sink.start(100);
    // "It is nearly…": "is" ends at character 5 → frame 5000; 3800 + half a 100 ms fade = 5000.
    r.sink.current = { id: 100, frame: 3800 };

    r.frames(6, 0.9);
    expect(r.sink.gain).toEqual(['duck']);
    expect(r.of('assistant.interrupted')).toHaveLength(0);
    r.frames(1, 0.9); // 224 ms of speech: past bargeInMs
    expect(r.of('assistant.interrupted')).toEqual([
      { sessionId: 's', at: AT, type: 'assistant.interrupted', spokenPrefix: 'It is' },
    ]);
    // The reply asks for the fade and so does the machine entering `interrupted`; a real
    // sink hands both the same fade.
    expect(r.sink.fades).toEqual([100, 100]);
    await settle();
    expect(r.state()).toBe('listening');
    expect(r.of('assistant.message')[0]?.entry).toMatchObject({ text: ANSWER, spokenPrefix: 'It is' });

    // The interjection is a turn of its own.
    r.frames(20, 0.05);
    await settle();
    expect(r.of('user.turn.ended')).toHaveLength(2);
    expect(r.replies).toHaveLength(2);
  });

  it('with bargeInMs 0 cuts on the first speech frame, as the plan first said', async () => {
    const r = rig({ bargeIn: { bargeInMs: 0 } });
    await turn(r);
    r.sink.start(100);
    r.frames(1, 0.9);
    expect(r.of('assistant.interrupted')).toHaveLength(1);
    expect(r.sink.gain).toEqual([]);
  });

  it('does nothing on speech once the answer has finished', async () => {
    const r = rig();
    await turn(r);
    r.sink.start(100);
    r.sink.end(100);
    await settle();
    r.frames(8, 0.9);
    expect(r.sink.gain).toEqual([]);
    expect(r.of('assistant.interrupted')).toHaveLength(0);
  });
});
