import { describe, expect, it } from 'vitest';
import type { CancellationSignal, ConversationEvent, LLMProvider, LlmRequest, LlmStreamChunk } from '@latentpresence/protocol';
import { ConversationMachine } from '../conversation/machine';
import { deferred, ManualSink, ScriptedTTS, settle, text } from '../testing/scripted';
import { emptyTranscript, reduceTranscript } from '../transcript/transcript';
import { ChatSession, NO_TEXT_LENGTH_MESSAGE } from './session';

/** Replays one script per request, optionally stopping at a gate, and keeps every request. */
class ChatLLM implements LLMProvider {
  readonly id = 'chat-llm';
  readonly requests: LlmRequest[] = [];
  readonly signals: CancellationSignal[] = [];
  private readonly scripts: (readonly LlmStreamChunk[])[];
  private readonly gate: { promise: Promise<void>; after: number } | undefined;
  private readonly fail: Error | undefined;
  constructor(scripts: (readonly LlmStreamChunk[])[], gate?: { promise: Promise<void>; after: number }, fail?: Error) {
    this.scripts = scripts;
    this.gate = gate;
    this.fail = fail;
  }
  async listModels(): Promise<never[]> {
    return [];
  }
  async *stream(request: LlmRequest, options?: { signal?: CancellationSignal }): AsyncIterable<LlmStreamChunk> {
    this.requests.push(JSON.parse(JSON.stringify(request)) as LlmRequest);
    if (options?.signal !== undefined) this.signals.push(options.signal);
    const script = this.scripts[this.requests.length - 1] ?? [];
    for (const [i, chunk] of script.entries()) {
      if (this.gate !== undefined && i === this.gate.after) await this.gate.promise;
      if (options?.signal?.aborted === true) return;
      yield chunk;
    }
    if (this.fail !== undefined) throw this.fail;
  }
}

function rig(llm: LLMProvider, extra: { system?: string } = {}) {
  const machine = new ConversationMachine({ sessionId: 'c', characterId: 'alice', now: () => '2026-09-14T00:00:00.000Z' });
  const events: ConversationEvent[] = [];
  machine.subscribe((event) => events.push(event));
  const chat = new ChatSession({ sessionId: 'c', machine, llm, modelId: 'm', temperature: 0.7, ...extra });
  machine.start();
  return {
    chat,
    machine,
    types: () => events.map((event) => event.type).filter((type) => type !== 'state.changed'),
    of<T extends ConversationEvent['type']>(type: T): Extract<ConversationEvent, { type: T }>[] {
      return events.filter((event): event is Extract<ConversationEvent, { type: T }> => event.type === type);
    },
  };
}

describe('ChatSession — a typed turn', () => {
  it("puts a typed answer's sentences on the bus with their tags, so the affect engine feels them (P3-T09)", async () => {
    const r = rig(new ChatLLM([text('[emote:sadness] Oh. ', 'I see.')]));
    r.chat.send('my cat died');
    await settle();
    expect(r.of('assistant.sentence').map((event) => [event.text, event.tags.map((tag) => tag.known)])).toEqual([
      ['Oh.', ['sadness']],
      ['I see.', []],
    ]);
    expect(r.of('assistant.message')[0]?.entry.text).toBe('Oh. I see.');
  });

  it('puts the message on the bus, streams the answer as tokens, settles it and returns to listening', async () => {
    const r = rig(new ChatLLM([text('It is ', 'three.')]));
    expect(r.chat.send('  what time is it  ')).toBe(true);
    expect(r.machine.getState()).toBe('thinking');
    expect(r.chat.busy).toBe(true);
    await settle();

    // P3-T09: the answer's sentences too, so the affect engine can feel a typed answer's tags.
    expect(r.types()).toEqual(['session.started', 'user.message', 'assistant.token', 'assistant.token', 'assistant.sentence', 'assistant.message']);
    expect(r.of('user.message')[0]?.text).toBe('what time is it');
    expect(r.of('assistant.message')[0]?.entry).toMatchObject({ id: 'c-reply-1', role: 'assistant', text: 'It is three.', spokenPrefix: null });
    expect(r.machine.getState()).toBe('listening');
    expect(r.chat.busy).toBe(false);
  });

  it('ignores blank text', () => {
    const r = rig(new ChatLLM([]));
    expect(r.chat.send('   ')).toBe(false);
    expect(r.types()).toEqual(['session.started']);
  });

  it('sends the whole conversation each time, with the system prompt first and what was shown of each answer', async () => {
    const gate = deferred();
    const llm = new ChatLLM([text('First ', 'answer, long.'), text('Second.')], { promise: gate.promise, after: 1 });
    const r = rig(llm, { system: 'You are Alice.' });
    r.chat.send('one');
    await settle();
    r.chat.stop(); // only "First " was shown
    gate.resolve();
    r.chat.send('two');
    await settle();

    expect(llm.requests[1]?.messages).toEqual([
      { role: 'system', content: 'You are Alice.' },
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'First ', toolCalls: [] },
      { role: 'user', content: 'two' },
    ]);
    expect(llm.requests[1]).toMatchObject({ modelId: 'm', temperature: 0.7, tools: [], maxOutputTokens: null });
  });
});

describe('ChatSession — stopping', () => {
  it('cuts the answer where it is, marks what was shown, stops the model and returns to listening', async () => {
    const gate = deferred();
    const llm = new ChatLLM([text('Half ', 'of it.')], { promise: gate.promise, after: 1 });
    const r = rig(llm);
    r.chat.send('go');
    await settle();
    r.chat.stop();

    expect(llm.signals[0]?.aborted).toBe(true);
    expect(r.of('assistant.interrupted')[0]?.spokenPrefix).toBe('Half ');
    expect(r.of('assistant.message')[0]?.entry).toMatchObject({ text: 'Half ', spokenPrefix: 'Half ' });
    expect(r.machine.getState()).toBe('listening');

    // The model finishing late changes nothing.
    gate.resolve();
    await settle();
    expect(r.of('assistant.message')).toHaveLength(1);
    expect(r.of('assistant.token')).toHaveLength(1);
  });

  it('settles empty when stopped before any text, so the machine is not left thinking', async () => {
    const gate = deferred();
    const r = rig(new ChatLLM([text('Late.')], { promise: gate.promise, after: 0 }));
    r.chat.send('go');
    r.chat.stop();
    expect(r.of('assistant.interrupted')).toHaveLength(0);
    expect(r.of('assistant.message')[0]?.entry).toMatchObject({ text: '', spokenPrefix: '' });
    expect(r.machine.getState()).toBe('listening');
    expect(r.chat.messages).toEqual([{ role: 'user', content: 'go' }]);
  });

  it('a second message while the first streams stops the first, then answers the second', async () => {
    const gate = deferred();
    const llm = new ChatLLM([text('Slow ', 'answer.'), text('Quick.')], { promise: gate.promise, after: 1 });
    const r = rig(llm);
    r.chat.send('first');
    await settle();
    r.chat.send('second');
    await settle();
    gate.resolve();
    await settle();

    expect(r.types().slice(1)).toEqual([
      'user.message',
      'assistant.token',
      'assistant.interrupted',
      'assistant.message',
      'user.message',
      'assistant.token',
      'assistant.sentence',
      'assistant.message',
    ]);
    expect(r.of('assistant.message').map((event) => event.entry.id)).toEqual(['c-reply-1', 'c-reply-2']);
    expect(r.machine.getState()).toBe('listening');
  });

  it('dispose stops the answer and refuses later messages', async () => {
    const gate = deferred();
    const r = rig(new ChatLLM([text('A ', 'b.')], { promise: gate.promise, after: 1 }));
    r.chat.send('go');
    await settle();
    r.chat.dispose();
    expect(r.chat.busy).toBe(false);
    expect(r.chat.send('again')).toBe(false);
  });
});

describe('ChatSession — failures', () => {
  it('reports a thinking model that wrote nothing as its own error, never a blank line', async () => {
    const r = rig(new ChatLLM([[{ type: 'reasoning-delta', text: 'hmm' }, { type: 'finish', reason: 'length', usage: null }]]));
    r.chat.send('go');
    await settle();
    expect(r.of('error')[0]).toMatchObject({ scope: 'llm', message: NO_TEXT_LENGTH_MESSAGE });
    expect(r.of('assistant.message')).toHaveLength(0);
    expect(r.of('assistant.token')).toHaveLength(0);
    expect(r.machine.getState()).toBe('listening');
  });

  it('reports a thrown model error and keeps what was shown before it', async () => {
    const r = rig(new ChatLLM([[{ type: 'text-delta', text: 'Partial' }]], undefined, new Error('401 Unauthorized')));
    r.chat.send('go');
    await settle();
    expect(r.of('error')[0]).toMatchObject({ scope: 'llm', message: '401 Unauthorized' });
    expect(r.of('assistant.message')[0]?.entry).toMatchObject({ text: 'Partial', spokenPrefix: 'Partial' });
    expect(r.machine.getState()).toBe('listening');
  });
});

/** A transcript's lines as words, badges aside. */
function words(events: ConversationEvent[]) {
  return events.reduce(reduceTranscript, emptyTranscript()).lines.map((line) => ('status' in line ? [line.kind, line.status, line.text] : [line.kind, line.text]));
}

/** P2-T08: the same rig with a voice, played by hand through `ManualSink`. */
function spokenRig(llm: LLMProvider, tts = new ScriptedTTS()) {
  const sink = new ManualSink();
  const r = rig(llm);
  r.chat.setVoice({ tts, sink, voiceId: 'af_heart' });
  return { ...r, sink, tts };
}

describe('ChatSession — spoken answers (P2-T08)', () => {
  it('speaks a typed turn as a call does: sentences with their tags, audio, speaking, then listening', async () => {
    const r = spokenRig(new ChatLLM([text('[emote:joy] Hello there. ', 'How are you?')]));
    expect(r.chat.speaking).toBe(true);
    r.chat.send('hi');
    await settle();

    expect(r.tts.requests.map((request) => request.text)).toEqual(['Hello there.', 'How are you?']);
    expect(r.tts.requests[0]?.voiceId).toBe('af_heart');
    expect(r.of('assistant.sentence').map((event) => event.tags.map((tag) => tag.value))).toEqual([['joy'], []]);
    expect(r.machine.getState()).toBe('thinking');

    r.sink.start(100);
    await settle();
    expect(r.machine.getState()).toBe('speaking');
    expect(r.of('assistant.audio.started')[0]?.timing?.durationMs).toBeGreaterThan(0);
    r.sink.end(100);
    r.sink.start(101);
    r.sink.end(101);
    await settle();

    expect(r.of('assistant.message')[0]?.entry).toMatchObject({ id: 'c-reply-1', text: 'Hello there. How are you?', spokenPrefix: null });
    expect(r.machine.getState()).toBe('listening');
    expect(r.chat.busy).toBe(false);
    expect(r.sink.listenerCount).toBe(0);
  });

  it('Stop while she is audible cuts the voice at what was heard, and that is what is remembered', async () => {
    const llm = new ChatLLM([text('One two three. ', 'Four five six.'), text('Next.')]);
    const r = spokenRig(llm);
    r.chat.send('count');
    await settle();
    r.sink.start(100);
    // Mid-sentence: "One two" played; the 100 ms fade's midpoint adds 1.2 k frames.
    r.sink.current = { id: 100, frame: 6_000 };
    r.chat.stop();

    expect(llm.signals[0]?.aborted).toBe(true);
    expect(r.sink.fades).toEqual([100]);
    const heard = r.of('assistant.interrupted')[0]?.spokenPrefix ?? '';
    expect(heard.length).toBeGreaterThan(0);
    expect('One two three. Four five six.'.startsWith(heard)).toBe(true);
    expect(heard).not.toBe('One two three. Four five six.');
    expect(r.of('assistant.message')[0]?.entry).toMatchObject({ text: 'One two three. Four five six.', spokenPrefix: heard });
    expect(r.machine.getState()).toBe('interrupted');
    expect(r.chat.busy).toBe(false);

    // The sink finishing the fade late settles nothing twice.
    r.sink.end(100);
    await settle();
    expect(r.of('assistant.message')).toHaveLength(1);
    expect(r.chat.messages.at(-1)).toEqual({ role: 'assistant', content: heard, toolCalls: [] });
  });

  it('Stop before a word was played settles as a typed answer does, as the text shown', async () => {
    const gate = deferred();
    const r = spokenRig(new ChatLLM([text('Half ', 'of it.')], { promise: gate.promise, after: 1 }));
    r.chat.send('go');
    await settle();
    r.chat.stop();

    expect(r.of('assistant.interrupted')[0]?.spokenPrefix).toBe('Half ');
    expect(r.of('assistant.message')[0]?.entry).toMatchObject({ text: 'Half ', spokenPrefix: 'Half ' });
    expect(r.of('assistant.audio.started')).toHaveLength(0);
    expect(r.machine.getState()).toBe('listening');
    gate.resolve();
    await settle();
    expect(r.sink.segments).toHaveLength(0);
    expect(r.of('assistant.message')).toHaveLength(1);
  });

  it('a voice that fails reports it and keeps what was heard', async () => {
    const r = spokenRig(new ChatLLM([text('Fine. ', 'Broken here.')]), new ScriptedTTS({ fail: 'Broken here.' }));
    r.chat.send('go');
    await settle();
    r.sink.start(100);
    r.sink.end(100);
    await settle();

    expect(r.of('error')[0]).toMatchObject({ scope: 'tts', message: 'voice failed on "Broken here."' });
    expect(r.of('assistant.message')[0]?.entry).toMatchObject({ text: 'Fine. Broken here.', spokenPrefix: 'Fine.' });
    expect(r.machine.getState()).toBe('listening');
  });

  it('turning the voice off mid-answer stops that answer, and the next one is text', async () => {
    const gate = deferred();
    const llm = new ChatLLM([text('Spoken ', 'answer.'), text('Typed.')], { promise: gate.promise, after: 1 });
    const r = spokenRig(llm);
    r.chat.send('one');
    await settle();
    r.chat.setVoice(null);
    expect(llm.signals[0]?.aborted).toBe(true);
    expect(r.chat.busy).toBe(false);
    expect(r.chat.speaking).toBe(false);

    gate.resolve();
    r.chat.send('two');
    await settle();
    expect(r.tts.requests).toHaveLength(0);
    expect(r.of('assistant.message').map((event) => event.entry.text)).toEqual(['Spoken ', 'Typed.']);
    expect(r.machine.getState()).toBe('listening');
  });

  it('leaves the transcript as a typed answer leaves it — the same lines, the same words', async () => {
    const script = () => new ChatLLM([text('[gesture:nod] Yes. ', 'Of course.')]);
    const typed = rig(script());
    const typedEvents: ConversationEvent[] = [];
    typed.machine.subscribe((event) => typedEvents.push(event));
    typed.chat.send('can you?');
    await settle();

    const spoken = spokenRig(script());
    const spokenEvents: ConversationEvent[] = [];
    spoken.machine.subscribe((event) => spokenEvents.push(event));
    spoken.chat.send('can you?');
    await settle();
    spoken.sink.start(100);
    spoken.sink.end(100);
    spoken.sink.start(101);
    spoken.sink.end(101);
    await settle();

    expect(words(spokenEvents)).toEqual(words(typedEvents));
    expect(words(spokenEvents)).toEqual([
      ['user', 'can you?'],
      ['assistant', 'complete', 'Yes. Of course.'],
    ]);
    expect(spoken.chat.messages).toEqual(typed.chat.messages);
  });
});
