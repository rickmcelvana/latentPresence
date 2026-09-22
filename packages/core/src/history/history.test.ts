import type { ConversationEvent } from '@latentpresence/protocol';
import { describe, expect, it } from 'vitest';
import { emptyTranscript, reduceTranscript, type TranscriptLine } from '../transcript/transcript';
import { ConversationHistory, attachHistory, historyFromTranscript } from './history';

const AT = '2026-09-21T00:00:00.000Z';

/** `Omit` over a discriminated union collapses it; this keeps the variants apart. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type BusEvent = DistributiveOmit<ConversationEvent, 'sessionId' | 'at'>;

function user(text: string): TranscriptLine {
  return { kind: 'user', id: 'u', text, at: AT, via: 'voice' };
}

function assistant(
  status: 'streaming' | 'complete' | 'interrupted',
  text: string,
  heard: string | null = null,
): TranscriptLine {
  return {
    kind: 'assistant',
    id: 'a',
    at: AT,
    status,
    text,
    heard,
    unsaid: heard === null ? '' : text.slice(heard.length),
    firstTokenMs: null,
    firstAudioMs: null,
  };
}

describe('historyFromTranscript', () => {
  it('turns a finished exchange into two messages', () => {
    expect(historyFromTranscript([user('hello'), assistant('complete', 'Hi there.')])).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'Hi there.', toolCalls: [] },
    ]);
  });

  it('remembers an interrupted answer as what was heard, never as what was generated', () => {
    // The whole reason this module exists. Ask "what did you just say?" after a barge-in
    // and the model must only be able to repeat the words that reached the ear.
    const lines = [user('tell me a story'), assistant('interrupted', 'Once upon a time there was a dog.', 'Once upon a')];
    expect(historyFromTranscript(lines)[1]).toEqual({ role: 'assistant', content: 'Once upon a', toolCalls: [] });
  });

  it('leaves out an answer nobody heard a word of', () => {
    const lines = [user('hello'), assistant('interrupted', 'I was going to say something.', '')];
    expect(historyFromTranscript(lines)).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('leaves out an answer that is still streaming', () => {
    expect(historyFromTranscript([user('hello'), assistant('streaming', 'Hi th')])).toEqual([
      { role: 'user', content: 'hello' },
    ]);
  });

  it('leaves out a failure notice', () => {
    // "The language model failed" is something the app said, not the character. Replaying
    // it invites the model to apologise for an error it did not make.
    const lines: TranscriptLine[] = [user('hello'), { kind: 'notice', id: 'n', at: AT, text: 'The language model failed: 401' }];
    expect(historyFromTranscript(lines)).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('merges consecutive same-role messages, because Anthropic rejects a prompt that does not alternate', () => {
    const lines = [user('first'), user('second'), assistant('complete', 'Both noted.')];
    expect(historyFromTranscript(lines)).toEqual([
      { role: 'user', content: 'first\nsecond' },
      { role: 'assistant', content: 'Both noted.', toolCalls: [] },
    ]);
  });

  it('keeps the newest messages when it is over the cap', () => {
    const lines = [user('one'), assistant('complete', 'A.'), user('two'), assistant('complete', 'B.')];
    expect(historyFromTranscript(lines, 2)).toEqual([
      { role: 'user', content: 'two' },
      { role: 'assistant', content: 'B.', toolCalls: [] },
    ]);
  });

  it('never opens the window on an assistant message', () => {
    // A conversation starting with the character answering nothing reads as a missing
    // turn, and some providers reject it outright.
    const lines = [user('one'), assistant('complete', 'A.'), user('two'), assistant('complete', 'B.')];
    expect(historyFromTranscript(lines, 3)[0]?.role).toBe('user');
  });
});

describe('ConversationHistory', () => {
  function bus(): { history: ConversationHistory; send: (event: BusEvent) => void } {
    const history = new ConversationHistory({ system: 'You are Alice.' });
    return {
      history,
      send: (event) => history.observe({ ...event, sessionId: 's', at: AT } as ConversationEvent),
    };
  }

  it('puts system first and the pending turn last', () => {
    const { history, send } = bus();
    send({ type: 'user.message', text: 'hello' });
    send({ type: 'assistant.message', entry: { id: 'a', role: 'assistant', text: 'Hi.', at: AT, spokenPrefix: null } });
    expect(history.request('and now?')).toEqual([
      { role: 'system', content: 'You are Alice.' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'Hi.', toolCalls: [] },
      { role: 'user', content: 'and now?' },
    ]);
  });

  it('omits system when there is none, rather than sending an empty one', () => {
    const history = new ConversationHistory();
    expect(history.request('hi')).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('ignores a blank pending turn', () => {
    const history = new ConversationHistory();
    expect(history.request('   ')).toEqual([]);
  });

  it('keeps system when cleared: it is who she is, not what happened', () => {
    const { history, send } = bus();
    send({ type: 'user.message', text: 'hello' });
    history.clear();
    expect(history.request()).toEqual([{ role: 'system', content: 'You are Alice.' }]);
  });

  it('agrees with the transcript the user is reading, line for line', () => {
    // The point of deriving one from the other: these two cannot drift apart.
    const { history, send } = bus();
    const events: ConversationEvent[] = [];
    const record = (event: BusEvent) => {
      const full = { ...event, sessionId: 's', at: AT } as ConversationEvent;
      events.push(full);
      send(event);
    };
    record({ type: 'user.message', text: 'tell me a story' });
    record({ type: 'assistant.interrupted', spokenPrefix: 'Once upon a' });
    record({
      type: 'assistant.message',
      entry: { id: 'a', role: 'assistant', text: 'Once upon a time there was a dog.', at: AT, spokenPrefix: 'Once upon a' },
    });
    const lines = events.reduce(reduceTranscript, emptyTranscript()).lines;
    expect(historyFromTranscript(lines)).toEqual(history.messages);
    expect(history.messages.at(-1)).toEqual({ role: 'assistant', content: 'Once upon a', toolCalls: [] });
  });
});

describe('attachHistory', () => {
  it('follows a machine until detached', () => {
    const listeners: ((event: ConversationEvent) => void)[] = [];
    const machine = {
      subscribe: (listener: (event: ConversationEvent) => void) => {
        listeners.push(listener);
        return () => listeners.splice(listeners.indexOf(listener), 1);
      },
    };
    const { history, detach } = attachHistory(machine);
    const send = (text: string) =>
      listeners.forEach((l) => l({ type: 'user.message', text, sessionId: 's', at: AT } as ConversationEvent));
    send('before');
    detach();
    send('after');
    expect(history.messages).toEqual([{ role: 'user', content: 'before' }]);
  });
});
