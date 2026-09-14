import { describe, expect, it } from 'vitest';
import type { ConversationEvent } from '@latentpresence/protocol';
import { ConversationMachine } from '../conversation/machine';
import { ChatSession } from '../chat/session';
import { ScriptedLLM, settle, text } from '../testing/scripted';
import { emptyTranscript, reduceTranscript, transcriptToText, type TranscriptLine, type TranscriptState } from './transcript';

const SID = 's1';

function iso(ms: number): string {
  return new Date(1_700_000_000_000 + ms).toISOString();
}

function fold(events: readonly ConversationEvent[]): TranscriptState {
  return events.reduce(reduceTranscript, emptyTranscript());
}

function base(ms: number): { sessionId: string; at: string } {
  return { sessionId: SID, at: iso(ms) };
}

describe('reduceTranscript — the event table', () => {
  it('user.turn.ended remembers the turn start and produces no line', () => {
    const state = fold([{ ...base(0), type: 'user.turn.ended', probability: 0.9 }]);
    expect(state.lines).toEqual([]);
    expect(state.turnStartAt).toBe(1_700_000_000_000);
  });

  it('user.turn.resumed forgets the start and produces no line', () => {
    const state = fold([
      { ...base(0), type: 'user.turn.ended', probability: 0.9 },
      { ...base(100), type: 'user.turn.resumed', pauseMs: 100 },
    ]);
    expect(state.lines).toEqual([]);
    expect(state.turnStartAt).toBeNull();
  });

  it('a final user.transcript is a voice line; a non-final one is ignored', () => {
    const state = fold([
      { ...base(0), type: 'user.transcript', text: 'partial', isFinal: false, confidence: 0.5 },
      { ...base(10), type: 'user.transcript', text: 'what time is it', isFinal: true, confidence: 0.9 },
    ]);
    expect(state.lines).toEqual([{ kind: 'user', id: 't-1', text: 'what time is it', at: iso(10), via: 'voice' }]);
  });

  it('user.message is a text line and starts the turn', () => {
    const state = fold([{ ...base(5), type: 'user.message', text: 'hello' }]);
    expect(state.lines).toEqual([{ kind: 'user', id: 't-1', text: 'hello', at: iso(5), via: 'text' }]);
    expect(state.turnStartAt).toBe(1_700_000_000_005);
  });

  it('assistant.token creates a streaming line, then appends to it; the first token sets firstTokenMs', () => {
    const state = fold([
      { ...base(0), type: 'user.turn.ended', probability: 0.9 },
      { ...base(412), type: 'assistant.token', text: 'It ' },
      { ...base(500), type: 'assistant.token', text: 'is three.' },
    ]);
    expect(state.lines).toEqual([
      {
        kind: 'assistant',
        id: 't-1',
        at: iso(412),
        status: 'streaming',
        text: 'It is three.',
        heard: null,
        unsaid: '',
        firstTokenMs: 412,
        firstAudioMs: null,
      },
    ]);
  });

  it('a token with no turn start leaves firstTokenMs null', () => {
    const state = fold([{ ...base(0), type: 'assistant.token', text: 'hi' }]);
    expect((state.lines[0] as TranscriptLine & { kind: 'assistant' }).firstTokenMs).toBeNull();
  });

  it('assistant.audio.started sets firstAudioMs once, on the current line', () => {
    const state = fold([
      { ...base(0), type: 'user.turn.ended', probability: 0.9 },
      { ...base(100), type: 'assistant.token', text: 'hi' },
      { ...base(893), type: 'assistant.audio.started', sentenceIndex: 0 },
      { ...base(2000), type: 'assistant.audio.started', sentenceIndex: 1 },
    ]);
    const line = state.lines[0] as Extract<TranscriptLine, { kind: 'assistant' }>;
    expect(line.firstAudioMs).toBe(893);
  });

  it('assistant.interrupted marks the current line interrupted; the settling message follows', () => {
    const state = fold([
      { ...base(0), type: 'user.turn.ended', probability: 0.9 },
      { ...base(100), type: 'assistant.token', text: 'Once upon' },
      { ...base(200), type: 'assistant.interrupted', spokenPrefix: 'Once upon' },
    ]);
    const line = state.lines[0] as Extract<TranscriptLine, { kind: 'assistant' }>;
    expect(line.status).toBe('interrupted');
  });

  it('assistant.message settles a streaming line as complete, spokenPrefix null', () => {
    const state = fold([
      { ...base(0), type: 'assistant.token', text: 'It is three.' },
      {
        ...base(50),
        type: 'assistant.message',
        entry: { id: 'e1', role: 'assistant', text: 'It is three.', at: iso(50), spokenPrefix: null },
      },
    ]);
    expect(state.lines).toEqual([
      {
        kind: 'assistant',
        id: 'e1',
        at: iso(50),
        status: 'complete',
        text: 'It is three.',
        heard: null,
        unsaid: '',
        firstTokenMs: null,
        firstAudioMs: null,
      },
    ]);
  });

  it('assistant.message with a spokenPrefix settles interrupted, splitting heard and unsaid', () => {
    const state = fold([
      { ...base(0), type: 'assistant.token', text: 'Once upon a time there was' },
      {
        ...base(50),
        type: 'assistant.message',
        entry: { id: 'e1', role: 'assistant', text: 'Once upon a time there was a dragon.', at: iso(50), spokenPrefix: 'Once upon a time there was' },
      },
    ]);
    const line = state.lines[0] as Extract<TranscriptLine, { kind: 'assistant' }>;
    expect(line.status).toBe('interrupted');
    expect(line.heard).toBe('Once upon a time there was');
    expect(line.unsaid).toBe(' a dragon.');
  });

  it('an entry with empty text removes the line', () => {
    const state = fold([
      { ...base(0), type: 'assistant.token', text: 'Half ' },
      { ...base(50), type: 'assistant.message', entry: { id: 'e1', role: 'assistant', text: '', at: iso(50), spokenPrefix: '' } },
    ]);
    expect(state.lines).toEqual([]);
  });

  it('with no current line, assistant.message creates one already settled', () => {
    const state = fold([
      { ...base(50), type: 'assistant.message', entry: { id: 'e1', role: 'assistant', text: 'Hi.', at: iso(50), spokenPrefix: null } },
    ]);
    expect(state.lines).toEqual([
      { kind: 'assistant', id: 'e1', at: iso(50), status: 'complete', text: 'Hi.', heard: null, unsaid: '', firstTokenMs: null, firstAudioMs: null },
    ]);
  });

  it('state.changed to listening drops a still-streaming line', () => {
    const state = fold([
      { ...base(0), type: 'assistant.token', text: 'Hi' },
      { ...base(10), type: 'state.changed', from: 'thinking', to: 'listening' },
    ]);
    expect(state.lines).toEqual([]);
  });

  it('state.changed to idle also drops a still-streaming line', () => {
    const state = fold([
      { ...base(0), type: 'assistant.token', text: 'Hi' },
      { ...base(10), type: 'state.changed', from: 'thinking', to: 'idle' },
    ]);
    expect(state.lines).toEqual([]);
  });

  it('state.changed does not drop a settled line', () => {
    const state = fold([
      { ...base(0), type: 'assistant.token', text: 'Hi' },
      { ...base(10), type: 'assistant.message', entry: { id: 'e1', role: 'assistant', text: 'Hi', at: iso(10), spokenPrefix: null } },
      { ...base(20), type: 'state.changed', from: 'speaking', to: 'listening' },
    ]);
    expect(state.lines).toHaveLength(1);
  });

  it('error becomes a notice line, worded by scope', () => {
    const state = fold([{ ...base(0), type: 'error', scope: 'llm', message: 'the model stream ended with an error' }]);
    expect(state.lines).toEqual([{ kind: 'notice', id: 't-1', at: iso(0), text: 'The language model failed: the model stream ended with an error' }]);
  });

  it('an stt error saying nothing was recognised is not a line', () => {
    const state = fold([{ ...base(0), type: 'error', scope: 'stt', message: 'nothing was recognised' }]);
    expect(state.lines).toEqual([]);
  });

  it('a different stt error is still a notice', () => {
    const state = fold([{ ...base(0), type: 'error', scope: 'stt', message: 'the microphone was lost' }]);
    expect(state.lines).toEqual([{ kind: 'notice', id: 't-1', at: iso(0), text: 'The hearing failed: the microphone was lost' }]);
  });

  it('assistant.backchannel is never a line', () => {
    const state = fold([{ ...base(0), type: 'assistant.backchannel', text: 'Yeah.' }]);
    expect(state.lines).toEqual([]);
  });

  it('everything else passes through with no line: sentences, speech edges, session traffic', () => {
    const state = fold([
      { ...base(0), type: 'session.started', characterId: 'alice' },
      { ...base(1), type: 'user.speech.started' },
      { ...base(2), type: 'user.speech.ended' },
      { ...base(3), type: 'assistant.sentence', text: 'Hi.', index: 0 },
      { ...base(4), type: 'assistant.audio.ended', sentenceIndex: 0 },
      { ...base(5), type: 'state.changed', from: 'idle', to: 'listening' },
      { ...base(6), type: 'session.ended', reason: 'user' },
    ]);
    expect(state.lines).toEqual([]);
  });
});

describe('reduceTranscript — sequences', () => {
  it('a full voice barge-in keeps exactly one interrupted line', () => {
    const state = fold([
      { ...base(0), type: 'user.turn.ended', probability: 0.9 },
      { ...base(50), type: 'user.transcript', text: 'tell me a story', isFinal: true, confidence: 0.9 },
      { ...base(100), type: 'assistant.token', text: 'Once upon a time' },
      { ...base(200), type: 'assistant.interrupted', spokenPrefix: 'Once upon a time' },
      {
        ...base(210),
        type: 'assistant.message',
        entry: { id: 'e1', role: 'assistant', text: 'Once upon a time there was a dragon.', at: iso(210), spokenPrefix: 'Once upon a time' },
      },
      { ...base(300), type: 'state.changed', from: 'interrupted', to: 'listening' },
    ]);
    expect(state.lines).toHaveLength(2);
    const assistantLine = state.lines[1] as Extract<TranscriptLine, { kind: 'assistant' }>;
    expect(assistantLine.status).toBe('interrupted');
    expect(assistantLine.heard).toBe('Once upon a time');
  });

  it('an abandoned voice reply — tokens, then back to listening, no message — leaves no line', () => {
    const state = fold([
      { ...base(0), type: 'user.turn.ended', probability: 0.9 },
      { ...base(50), type: 'user.transcript', text: 'hi', isFinal: true, confidence: 0.9 },
      { ...base(100), type: 'assistant.token', text: 'partial' },
      { ...base(150), type: 'state.changed', from: 'thinking', to: 'listening' },
    ]);
    expect(state.lines).toEqual([{ kind: 'user', id: 't-1', text: 'hi', at: iso(50), via: 'voice' }]);
  });

  it('a stopped chat reply with empty text leaves no line', () => {
    const state = fold([
      { ...base(0), type: 'user.message', text: 'go' },
      { ...base(10), type: 'assistant.message', entry: { id: 'e1', role: 'assistant', text: '', at: iso(10), spokenPrefix: '' } },
    ]);
    expect(state.lines).toEqual([{ kind: 'user', id: 't-1', text: 'go', at: iso(0), via: 'text' }]);
  });

  it('latency measures from user.turn.ended', () => {
    const state = fold([
      { ...base(0), type: 'user.turn.ended', probability: 0.9 },
      { ...base(300), type: 'assistant.token', text: 'hi' },
    ]);
    expect((state.lines[0] as Extract<TranscriptLine, { kind: 'assistant' }>).firstTokenMs).toBe(300);
  });

  it('latency measures from user.message', () => {
    const state = fold([
      { ...base(0), type: 'user.message', text: 'hi' },
      { ...base(150), type: 'assistant.token', text: 'hello' },
    ]);
    expect((state.lines[1] as Extract<TranscriptLine, { kind: 'assistant' }>).firstTokenMs).toBe(150);
  });

  it('user.turn.resumed nulls out the figure for what follows', () => {
    const state = fold([
      { ...base(0), type: 'user.turn.ended', probability: 0.9 },
      { ...base(50), type: 'user.turn.resumed', pauseMs: 50 },
      { ...base(300), type: 'assistant.token', text: 'hi' },
    ]);
    expect((state.lines[0] as Extract<TranscriptLine, { kind: 'assistant' }>).firstTokenMs).toBeNull();
  });
});

describe('reduceTranscript — driven by a real ChatSession', () => {
  it('reads the same lines the machine emits for a typed turn, with no drift between them', async () => {
    const machine = new ConversationMachine({ sessionId: SID, characterId: 'alice', now: () => iso(0) });
    let state = emptyTranscript();
    machine.subscribe((event) => {
      state = reduceTranscript(state, event);
    });
    const chat = new ChatSession({ sessionId: SID, machine, llm: new ScriptedLLM(text('It is ', 'three.')), modelId: 'm', now: () => iso(0) });
    machine.start();
    chat.send('what time is it');
    await settle();

    expect(state.lines).toEqual([
      { kind: 'user', id: 't-1', text: 'what time is it', at: iso(0), via: 'text' },
      {
        kind: 'assistant',
        id: `${SID}-reply-1`,
        at: iso(0),
        status: 'complete',
        text: 'It is three.',
        heard: null,
        unsaid: '',
        firstTokenMs: 0,
        firstAudioMs: null,
      },
    ]);
  });
});

describe('transcriptToText', () => {
  it('renders the note\'s exact shape: user, complete, interrupted, notice, and a streaming line as-is', () => {
    const lines: TranscriptLine[] = [
      { kind: 'user', id: '1', text: 'what time is it', at: iso(0), via: 'text' },
      { kind: 'assistant', id: '2', at: iso(1), status: 'complete', text: 'It is nearly three.', heard: null, unsaid: '', firstTokenMs: null, firstAudioMs: null },
      {
        kind: 'assistant',
        id: '3',
        at: iso(2),
        status: 'interrupted',
        text: 'Once upon a time there was a dragon.',
        heard: 'Once upon a time',
        unsaid: ' there was a dragon.',
        firstTokenMs: null,
        firstAudioMs: null,
      },
      { kind: 'notice', id: '4', at: iso(3), text: 'The language model failed: 401 Unauthorized' },
      { kind: 'assistant', id: '5', at: iso(4), status: 'streaming', text: 'Still going', heard: null, unsaid: '', firstTokenMs: null, firstAudioMs: null },
    ];
    expect(transcriptToText(lines, 'Alice')).toBe(
      [
        'You: what time is it',
        'Alice: It is nearly three.',
        'Alice: Once upon a time [interrupted]',
        '[error] The language model failed: 401 Unauthorized',
        'Alice: Still going',
      ].join('\n'),
    );
  });
});
