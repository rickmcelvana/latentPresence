import { describe, expect, it } from 'vitest';
import type { CancellationSignal, ConversationEvent, LlmRequest, LlmStreamChunk } from '@latentpresence/protocol';
import { ConversationMachine } from '../conversation/machine';
import type { BackchannelEvent, BackchannelOptions } from '../backchannel/scheduler';
import type { BargeInOptions } from '../reply/barge-in';
import { Reply, type ReplyOutcome } from '../reply/reply';
import { deferred, ManualSink, ScriptedLLM, ScriptedTTS, settle, text } from '../testing/scripted';
import { TurnDetector, type TurnJudge } from '../turn/detector';
import { emptyTranscript, reduceTranscript } from '../transcript/transcript';
import { VoiceSession, type RespondTurn } from './session';
import { ConversationHistory } from '../history/history';

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
    backchannel?: BackchannelOptions;
    now?: () => string;
    history?: ConversationHistory;
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
  const now = options.now ?? (() => AT);
  const machine = new ConversationMachine({ sessionId: 's', characterId: 'alice', now, ports: { audioOut: sink } });
  const events: ConversationEvent[] = [];
  machine.subscribe((event) => events.push(event));
  const replies: Reply[] = [];
  const backchannels: (BackchannelEvent & { lastProbability: number })[] = [];
  let lastProbability = 0;
  const outcomes: ReplyOutcome[] = [];
  /** What `respond` was handed each turn — the history question, in one place (P1-T12b). */
  const sent: RespondTurn[] = [];
  const session = new VoiceSession<string>({
    sessionId: 's',
    machine,
    detector,
    sink,
    now,
    transcribe: options.transcribe ?? (async () => 'what time is it'),
    ...(options.history === undefined ? {} : { history: options.history }),
    respond: (asked, replyOptions) => {
      sent.push(asked);
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
    ...(options.backchannel === undefined
      ? {}
      : {
          backchannel: {
            clips: [{ text: 'Yeah.', samples: new Float32Array(2400).fill(0.3), sampleRate: 24_000 }],
            random: () => 0,
            ...options.backchannel,
            onEvent: (event: BackchannelEvent) => backchannels.push({ ...event, lastProbability }),
          },
        }),
  });
  machine.start();

  return {
    session,
    machine,
    sink,
    replies,
    outcomes,
    sent,
    /** Every clip played or talked into, with the probability of the frame pushed before it. */
    backchannels,
    /** `count` 32 ms frames at `probability`. */
    frames(count: number, probability: number): void {
      for (let i = 0; i < count; i += 1) {
        const at = index * FRAME_MS;
        clock = at;
        index += 1;
        session.push({ samples: new Float32Array(FRAME), probability, at });
        lastProbability = probability;
      }
    },
    types: (): string[] => events.map((event) => event.type).filter((type) => type !== 'state.changed'),
    /** Every event on the bus, in order, state changes included. */
    all: (): readonly ConversationEvent[] => events,
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
      'assistant.token',
      'assistant.sentence',
    ]);
    expect(r.of('assistant.token').map((event) => event.text).join('')).toBe(ANSWER);
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
    expect(r.replies).toHaveLength(1);
    expect(r.sink.segments).toHaveLength(0);

    // confirmedAt = 288 + 500 = 788 ms: frame 24 is at 768, frame 25 at 800.
    r.frames(11, 0.05);
    await settle();
    expect(r.sink.segments).toHaveLength(0);
    r.frames(2, 0.05);
    await settle();
    expect(r.sink.segments).toHaveLength(1);
  });

  it("publishes the turn's words only once it is confirmed, stamped with when they happened", async () => {
    const judge = new Judge();
    let wall = 0;
    const r = rig({ judge, now: () => new Date(Date.UTC(2026, 8, 14, 0, 0, 0, wall)).toISOString() });
    r.frames(10, 0.9);
    r.frames(4, 0.05);
    wall = 100;
    judge.answer(0.95);
    await settle();
    // Recognised and answered, but the turn can still be taken back: nothing of it is out.
    expect(r.replies).toHaveLength(1);
    expect(r.of('user.transcript')).toHaveLength(0);
    expect(r.of('assistant.token')).toHaveLength(0);
    expect(r.of('assistant.sentence')).toHaveLength(0);

    wall = 600;
    r.frames(13, 0.05); // past confirmedAt (788 ms)
    await settle();
    const order = r.types().filter((type) => type.startsWith('user.transcript') || type.startsWith('assistant.'));
    expect(order.slice(0, 3)).toEqual(['user.transcript', 'assistant.token', 'assistant.sentence']);
    // Stamped when produced (100 ms), not when released (600 ms): a latency read off the
    // bus measures the model, not the retraction window.
    expect(r.of('user.transcript')[0]?.at).toBe('2026-09-14T00:00:00.100Z');
    expect(r.of('assistant.token')[0]?.at).toBe('2026-09-14T00:00:00.100Z');
    expect(r.of('assistant.audio.started')).toHaveLength(0);
  });

  it('publishes a hangover-ended turn at once, without waiting for another frame', async () => {
    const r = rig();
    r.frames(10, 0.9);
    let frames = 0;
    while (r.of('user.turn.ended').length === 0 && frames < 40) {
      r.frames(1, 0.05);
      frames += 1;
    }
    expect(r.of('user.turn.ended')[0]?.probability).toBeNull();
    // No frame after the turn end: `push` confirms a hangover end on the frame that ends it.
    await settle();
    expect(r.of('user.transcript')).toHaveLength(1);
    expect(r.sink.segments).toHaveLength(1);
  });

  it('never publishes the words of a turn that was retracted', async () => {
    const judge = new Judge();
    const r = rig({ judge, transcribe: async () => 'the afternoon light' });
    r.frames(10, 0.9);
    r.frames(4, 0.05);
    judge.answer(0.95);
    await settle();
    r.frames(3, 0.05);
    r.frames(6, 0.9);
    await settle();
    expect(r.of('user.turn.resumed')).toHaveLength(1);
    expect(r.of('user.transcript')).toHaveLength(0);
    expect(r.of('assistant.token')).toHaveLength(0);
    expect(r.of('assistant.sentence')).toHaveLength(0);
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

  it('reads as a transcript: the question, the words heard, the unsaid rest, and the interjection', async () => {
    // The real session's events through the real reducer (P1-T11), so neither can drift.
    const r = rig({ transcribe: async () => 'what time is it' });
    await turn(r);
    r.sink.start(100);
    r.sink.current = { id: 100, frame: 3800 };
    r.frames(7, 0.9);
    await settle();
    r.frames(20, 0.05);
    await settle();

    const lines = r.all().reduce(reduceTranscript, emptyTranscript()).lines;
    expect(lines.slice(0, 3).map((line) => (line.kind === 'assistant' ? [line.kind, line.status, line.heard, line.unsaid] : [line.kind, line.text]))).toEqual([
      ['user', 'what time is it'],
      ['assistant', 'interrupted', 'It is', " nearly three o'clock."],
      ['user', 'what time is it'],
    ]);
    // The interjection's own answer is streaming or settled, never a second copy of the first.
    expect(lines.filter((line) => line.kind === 'assistant' && line.status === 'interrupted')).toHaveLength(1);
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

describe('VoiceSession — backchannels (P1-T09)', () => {
  it('says one in a pause that sounds unfinished, without leaving listening or ending the turn', async () => {
    const judge = new Judge();
    const r = rig({ judge, backchannel: {} });
    r.frames(100, 0.9); // 3.2 s of speech
    r.frames(4, 0.05); // the candidate
    judge.answer(0.1);
    await settle();

    expect(r.of('assistant.backchannel').map((event) => event.text)).toEqual(['Yeah.']);
    expect(r.sink.segments).toHaveLength(1);
    expect(r.state()).toBe('listening');
    expect(r.types()).toEqual(['session.started', 'user.speech.started', 'assistant.backchannel']);

    // The user carries on: the clip yields on that frame, and the turn is still theirs.
    r.frames(1, 0.9);
    expect(r.sink.gain).toEqual(['duck']);
    expect(r.backchannels.map((event) => event.type)).toEqual(['played', 'overlapped']);
    expect(r.of('user.turn.ended')).toHaveLength(0);

    // The word finishes, and the voice is back at full level for whatever comes next.
    r.sink.end(100);
    expect(r.sink.gain).toEqual(['duck', 'unduck']);
  });

  it('plays at most once per 8 s and never starts over user speech, through a long turn', async () => {
    const judge = new Judge();
    const r = rig({ judge, backchannel: {} });
    // Forty seconds of talk in 1.1 s phrases, each followed by a pause judged unfinished.
    for (let phrase = 0; phrase < 36; phrase += 1) {
      r.frames(1, 0.9);
      // A clip lasts about as long as the next phrase's first half second.
      if (r.session.backchannels?.active === true) {
        r.frames(14, 0.9);
        r.sink.end(99 + r.sink.segments.length);
        r.frames(15, 0.9);
      } else {
        r.frames(29, 0.9);
      }
      r.frames(4, 0.05);
      judge.answer(0.1);
      await settle();
    }
    r.frames(1, 0.9);

    const played = r.backchannels.filter((event) => event.type === 'played');
    const overlapped = r.backchannels.filter((event) => event.type === 'overlapped');
    expect(played.length).toBe(5);
    for (const [i, event] of played.entries()) {
      // Started in silence, and yielded on the very next frame of speech.
      expect(event.lastProbability).toBeLessThan(0.35);
      expect(overlapped[i]?.at).toBe(event.at + FRAME_MS);
      if (i > 0) expect(event.at - (played[i - 1]?.at ?? 0)).toBeGreaterThanOrEqual(8000);
    }
    // Every duck given back once its word finished.
    expect(r.sink.gain).toEqual(Array.from({ length: 5 }, () => ['duck', 'unduck']).flat());
    expect(r.of('assistant.backchannel')).toHaveLength(5);
    expect(r.of('user.turn.ended')).toHaveLength(0);
  });

  it("with overlap 'cut' fades the clip on the first frame of speech", async () => {
    const judge = new Judge();
    const r = rig({ judge, backchannel: { overlap: 'cut' } });
    r.frames(100, 0.9);
    r.frames(4, 0.05);
    judge.answer(0.1);
    await settle();
    r.frames(1, 0.9);
    expect(r.sink.fades).toEqual([50]);
    expect(r.sink.gain).toEqual([]);
  });

  it('never says one while the character is audible', async () => {
    const judge = new Judge();
    const r = rig({ judge, backchannel: { minSpeechMs: 0 } });
    await turn(r);
    judge.answer(0.1);
    await settle();
    r.sink.start(100);
    expect(r.state()).toBe('speaking');

    r.frames(3, 0.9); // a cough: ducks, never commits
    r.frames(4, 0.05);
    judge.answer(0.1);
    await settle();
    expect(r.of('assistant.backchannel')).toHaveLength(0);
    expect(r.sink.segments).toHaveLength(1);
  });

  it('never says one without clips', async () => {
    const judge = new Judge();
    const r = rig({ judge });
    r.frames(100, 0.9);
    r.frames(4, 0.05);
    judge.answer(0.1);
    await settle();
    expect(r.session.backchannels).toBeNull();
    expect(r.of('assistant.backchannel')).toHaveLength(0);
  });
});

describe('VoiceSession — conversation history (P1-T12b)', () => {
  /** Play a whole turn through to its audio finishing, so the answer settles. */
  async function fullTurn(r: ReturnType<typeof rig>): Promise<void> {
    await turn(r);
    r.sink.start(100);
    r.sink.end(100);
    await settle();
  }

  it('sends this turn last, and the one before it before that', async () => {
    // The gap R-6 found: before this, every spoken turn was a standalone request and the
    // character answered with no idea what either of them had just said.
    const r = rig();
    await fullTurn(r);
    await fullTurn(r);

    expect(r.sent[0]?.messages).toEqual([{ role: 'user', content: 'what time is it' }]);
    expect(r.sent[1]?.messages).toEqual([
      { role: 'user', content: 'what time is it' },
      { role: 'assistant', content: ANSWER, toolCalls: [] },
      { role: 'user', content: 'what time is it' },
    ]);
  });

  it('sends the persona first when the history has one', async () => {
    const history = new ConversationHistory({ system: 'You are Alice.' });
    const r = rig({ history });
    // A history passed in is the caller's to attach, which is the documented contract.
    r.machine.subscribe((event) => history.observe(event));
    await fullTurn(r);
    expect(r.sent[0]?.messages[0]).toEqual({ role: 'system', content: 'You are Alice.' });
  });

  it('remembers an interrupted answer as what was heard, not what was generated', () => {
    // P1-T12b's done-when: a barge-in, then another turn, and the model can only repeat
    // the words that reached the ear. ADR-26's spoken prefix is what history keeps.
    const r = rig();
    return (async () => {
      await turn(r);
      r.sink.start(100);
      r.sink.current = { id: 100, frame: 3800 };
      r.frames(7, 0.9); // past bargeInMs: commits
      await settle();
      expect(r.of('assistant.interrupted')[0]?.spokenPrefix).toBe('It is');

      // The interjection is its own turn, and it carries the history.
      r.frames(20, 0.05);
      await settle();

      const second = r.sent[1]?.messages ?? [];
      expect(second).toEqual([
        { role: 'user', content: 'what time is it' },
        { role: 'assistant', content: 'It is', toolCalls: [] },
        { role: 'user', content: 'what time is it' },
      ]);
      // The words the model generated but nobody heard are nowhere in the request.
      expect(JSON.stringify(second)).not.toContain('nearly');
    })();
  });

  it('a retracted turn leaves nothing behind for the next one', async () => {
    // ADR-25: the words never reached the bus, so they are not in the history either.
    const judge = new Judge();
    const r = rig({ judge });
    r.frames(10, 0.9);
    r.frames(4, 0.05);
    judge.answer(0.95);
    await settle();
    expect(r.replies).toHaveLength(1);

    // Speech resumes before `confirmedAt`: the turn is retracted and publishes nothing.
    r.frames(6, 0.9);
    await settle();
    expect(r.of('user.turn.resumed')).toHaveLength(1);
    expect(r.of('user.transcript')).toHaveLength(0);

    // The next turn's request carries only itself — no ghost of the retracted one.
    r.frames(20, 0.05);
    judge.answer(0.95);
    await settle();
    expect(r.sent.at(-1)?.messages).toEqual([{ role: 'user', content: 'what time is it' }]);
  });

  it('one history shared with a ChatSession is one conversation', async () => {
    // Typing and talking are the same conversation, which is the point of sharing one.
    const history = new ConversationHistory();
    const r = rig({ history });
    const detach = r.machine.subscribe((event) => history.observe(event));
    await fullTurn(r);
    detach();
    // A typed message would be appended to exactly what the spoken turn left behind.
    expect(history.request('and by text?')).toEqual([
      { role: 'user', content: 'what time is it' },
      { role: 'assistant', content: ANSWER, toolCalls: [] },
      { role: 'user', content: 'and by text?' },
    ]);
  });
});
