import { describe, expect, it } from 'vitest';
import type { LLMProvider, LlmRequest, TTSProvider } from '@latentpresence/protocol';
import { deferred, ManualSink, ScriptedLLM, ScriptedTTS, settle, text } from '../testing/scripted';
import { Reply, type ReplyEvent, type ReplyOutcome } from './reply';

const request: LlmRequest = {
  modelId: 'scripted',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [],
  temperature: null,
  maxOutputTokens: null,
};

function make(llm: LLMProvider, tts = new ScriptedTTS(), hold?: Promise<void>) {
  const sink = new ManualSink();
  const events: ReplyEvent[] = [];
  const reply = new Reply(request, { llm, tts, sink, voiceId: 'v' }, {
    ...(hold === undefined ? {} : { hold }),
    onEvent: (event) => events.push(event),
  });
  let outcome: ReplyOutcome | null = null;
  void reply.done.then((o) => {
    outcome = o;
  });
  return { reply, sink, events, tts, outcome: () => outcome };
}

describe('Reply — a complete answer', () => {
  it('speaks each sentence in order and settles only when the last frame has played', async () => {
    const { sink, events, tts, outcome } = make(new ScriptedLLM(text('Hello there. ', 'How are you?')));
    await settle();

    expect(tts.requests.map((r) => r.text)).toEqual(['Hello there.', 'How are you?']);
    expect(sink.segments.map((s) => s.samples.length)).toEqual([12_000, 12_000]);
    expect(outcome()).toBeNull();

    sink.start(100);
    sink.end(100);
    sink.start(101);
    await settle();
    expect(outcome()).toBeNull();
    sink.end(101);
    await settle();

    expect(outcome()).toEqual({ status: 'complete', text: 'Hello there. How are you?' });
    expect(events.map((e) => `${e.type}:${e.index}`)).toEqual([
      'sentence:0', 'sentence:1', 'audio-started:0', 'audio-ended:0', 'audio-started:1', 'audio-ended:1',
    ]);
    expect(sink.listenerCount).toBe(0);
  });

  it('synthesises before the turn is confirmed but queues nothing until it is', async () => {
    const hold = deferred();
    const { sink, tts } = make(new ScriptedLLM(text('Hello there.')), new ScriptedTTS(), hold.promise);
    await settle();
    expect(tts.requests).toHaveLength(1);
    expect(sink.segments).toHaveLength(0);

    hold.resolve();
    await settle();
    expect(sink.segments).toHaveLength(1);
  });

  it('carries backend word timings through to the prefix', async () => {
    const { reply, sink } = make(new ScriptedLLM(text('Hello there.')), new ScriptedTTS({ words: true }));
    await settle();
    sink.start(100);
    // The backend says "Hello" ends at 10 ms = 240 frames. By characters it would end at 5000.
    sink.current = { id: 100, frame: 300 };
    expect(reply.interrupt(0)).toEqual({ status: 'interrupted', text: 'Hello there.', spokenPrefix: 'Hello' });
  });
});

describe('Reply — edges', () => {
  it('trims each sentence to its voice plus the padding before queueing it', async () => {
    const padded: TTSProvider = {
      id: 'padded',
      capabilities: () => Promise.reject(new Error('unused')),
      listVoices: () => Promise.resolve([]),
      async *synthesize() {
        // 300 ms of silence, 1 s of voice, 500 ms of silence: Kokoro's shape.
        const samples = new Float32Array(43_200);
        samples.fill(0.5, 7200, 31_200);
        yield { samples, sampleRate: 24_000, startMs: 0, isFinal: true };
      },
    };
    const sink = new ManualSink();
    const trimmed = new Reply(request, { llm: new ScriptedLLM(text('Hello there.')), tts: padded, sink, voiceId: 'v' });
    await settle();
    // 50 ms + 1 s + 250 ms at 24 kHz.
    expect(sink.segments[0]?.samples.length).toBe(1200 + 24_000 + 6000);

    const untrimmed = new ManualSink();
    const whole = new Reply(request, { llm: new ScriptedLLM(text('Hello there.')), tts: padded, sink: untrimmed, voiceId: 'v', padding: null });
    await settle();
    expect(untrimmed.segments[0]?.samples.length).toBe(43_200);
    expect([trimmed.text, whole.text]).toEqual(['Hello there.', 'Hello there.']);
  });
});

describe('Reply — interrupt', () => {
  it('stops the model, drops the rest and keeps only the words heard up to the fade midpoint', async () => {
    const gate = deferred();
    // The third sentence is held back in the model until after the interrupt.
    const llm = new ScriptedLLM(text('Hello there. ', 'How are you today? ', 'Fine.'), gate.promise, 2);
    const { reply, sink, events, tts, outcome } = make(llm);
    await settle();

    sink.start(100);
    sink.end(100);
    sink.start(101);
    // "How are you today?" — "are" ends at character 7 → frame 7000. At frame 5800 with a
    // 100 ms fade, the midpoint is 5800 + 1200 = 7000: "are" is heard, "you" is not.
    sink.current = { id: 101, frame: 5800 };
    const cut = reply.interrupt(100);

    expect(cut).toEqual({
      status: 'interrupted',
      text: 'Hello there. How are you today?',
      spokenPrefix: 'Hello there. How are',
    });
    expect(sink.fades).toEqual([100]);
    expect(llm.signal?.aborted).toBe(true);

    gate.resolve();
    await settle();
    expect(outcome()).toEqual(cut);
    expect(tts.requests).toHaveLength(2);
    expect(llm.yielded).toBe(2);
    const after = events.length;
    sink.end(101);
    expect(events).toHaveLength(after);
  });

  it('counts the fade into the next sentence when it crosses the boundary', async () => {
    const { reply, sink } = make(new ScriptedLLM(text('Hello there. ', 'How are you?')));
    await settle();
    sink.start(100);
    // 11 000 of 12 000 frames, plus a 250 ms fade's half (3000): 2000 frames into "How are you?".
    sink.current = { id: 100, frame: 11_000 };
    expect(reply.interrupt(250)).toMatchObject({ spokenPrefix: 'Hello there.' });
  });

  it('keeps every finished sentence when cut between sentences', async () => {
    const { reply, sink } = make(new ScriptedLLM(text('Hello there. ', 'How are you?')));
    await settle();
    sink.start(100);
    sink.end(100);
    expect(reply.interrupt(100)).toMatchObject({ status: 'interrupted', spokenPrefix: 'Hello there.' });
  });

  it('abandons an answer nobody heard, and flushes audio that was queued', async () => {
    const { reply, sink, outcome } = make(new ScriptedLLM(text('Hello there.')));
    await settle();
    expect(sink.segments).toHaveLength(1);
    expect(reply.interrupt(100)).toEqual({ status: 'abandoned', text: 'Hello there.' });
    expect(sink.fades).toEqual([100]);
    await settle();
    expect(outcome()).toEqual({ status: 'abandoned', text: 'Hello there.' });
  });

  it('does not touch the sink when this answer never queued anything', async () => {
    const hold = deferred();
    const { reply, sink } = make(new ScriptedLLM(text('Hello there.')), new ScriptedTTS(), hold.promise);
    await settle();
    expect(reply.interrupt(100).status).toBe('abandoned');
    expect(sink.fades).toEqual([]);
    hold.resolve();
    await settle();
    expect(sink.segments).toHaveLength(0);
  });

  it('ignores a position that belongs to some other answer', async () => {
    const { reply, sink } = make(new ScriptedLLM(text('Hello there.')));
    await settle();
    sink.current = { id: 7, frame: 5000 };
    expect(reply.interrupt(100).status).toBe('abandoned');
  });

  it('returns the settled outcome on a second call and after completion', async () => {
    const { reply, sink } = make(new ScriptedLLM(text('Hi.')));
    await settle();
    sink.start(100);
    sink.end(100);
    await settle();
    expect(reply.interrupt(100)).toEqual({ status: 'complete', text: 'Hi.' });
    expect(sink.fades).toEqual([]);
  });
});

describe('Reply — failures', () => {
  it('plays what was queued, then reports a model error with what was heard', async () => {
    const llm = new ScriptedLLM([{ type: 'text-delta', text: 'Hello there. And' }], undefined, Infinity, new Error('socket closed'));
    const { sink, outcome } = make(llm);
    await settle();
    expect(sink.segments).toHaveLength(1);
    expect(outcome()).toBeNull();
    sink.start(100);
    sink.end(100);
    await settle();
    expect(outcome()).toEqual({
      status: 'failed',
      text: 'Hello there.',
      spokenPrefix: 'Hello there.',
      scope: 'llm',
      error: 'socket closed',
    });
  });

  it('reports a stream that finished with an error reason', async () => {
    const llm = new ScriptedLLM([{ type: 'finish', reason: 'error', usage: null }]);
    const { outcome } = make(llm);
    await settle();
    expect(outcome()).toMatchObject({ status: 'failed', error: 'the model stream ended with an error' });
  });

  it('treats an answer with no text as a failure, not as a silent success', async () => {
    const llm = new ScriptedLLM([
      { type: 'reasoning-delta', text: 'hmm' },
      { type: 'finish', reason: 'length', usage: null },
    ]);
    const { outcome } = make(llm);
    await settle();
    expect(outcome()).toEqual({
      status: 'failed',
      text: '',
      spokenPrefix: '',
      scope: 'llm',
      error: 'the model produced no text to speak',
    });
  });

  it('stops synthesising after the voice fails, and says why', async () => {
    const tts = new ScriptedTTS({ fail: 'How are you?' });
    const { sink, outcome } = make(new ScriptedLLM(text('Hello there. ', 'How are you? ', 'Good.')), tts);
    await settle();
    expect(tts.requests.map((r) => r.text)).toEqual(['Hello there.', 'How are you?']);
    sink.start(100);
    sink.end(100);
    await settle();
    expect(outcome()).toMatchObject({ status: 'failed', spokenPrefix: 'Hello there.', scope: 'tts', error: 'voice failed on "How are you?"' });
  });
});
