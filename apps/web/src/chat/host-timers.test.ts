import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationMachine } from '@latentpresence/core';
import { hostTimers } from './host-timers';

/**
 * The scheduler `/chat` gives its machine, and the defect it exists for.
 *
 * This is a test of a *fact about the machine*, not about the helper: the helper is three
 * lines, and the reason it is there is that `startTeardownTimer` returns silently when it
 * has neither an `audioOut` port nor a scheduler. `/chat` has no port — the audio graph
 * belongs to a call that may not exist — so without this the state after every barge-in and
 * every typed Stop would be `interrupted` for the life of the page.
 */

function machine(scheduler?: ReturnType<typeof hostTimers>): ConversationMachine {
  const built = new ConversationMachine({
    sessionId: 'chat',
    characterId: 'alice',
    ...(scheduler === undefined ? {} : { scheduler }),
  });
  built.start();
  return built;
}

/** An answer is audible: the only state a barge-in can be committed from. */
function startSpeaking(built: ConversationMachine): void {
  built.dispatch({ type: 'user.message', text: 'hello', sessionId: 'chat', at: '2026-09-22T00:00:00.000Z' });
  built.dispatch({ type: 'assistant.audio.started', sentenceIndex: 0, sessionId: 'chat', at: '2026-09-22T00:00:00.000Z' });
}

describe('hostTimers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the machine to listening after a barge-in fade', () => {
    const built = machine(hostTimers());
    startSpeaking(built);
    expect(built.getState()).toBe('speaking');

    built.dispatch({ type: 'assistant.interrupted', spokenPrefix: 'hel', sessionId: 'chat', at: '2026-09-22T00:00:00.000Z' });
    expect(built.getState()).toBe('interrupted');

    // 100 ms, the machine's own default fade.
    vi.advanceTimersByTime(150);
    expect(built.getState()).toBe('listening');
  });

  it('is what makes the difference: without a scheduler the machine never leaves interrupted', () => {
    // The negative case, so the test above cannot pass for the wrong reason — a scheduler
    // that is never consulted would look identical from the outside.
    const built = machine();
    startSpeaking(built);
    built.dispatch({ type: 'assistant.interrupted', spokenPrefix: 'hel', sessionId: 'chat', at: '2026-09-22T00:00:00.000Z' });

    vi.advanceTimersByTime(5_000);
    expect(built.getState()).toBe('interrupted');
  });

  it('starts no idle timer, because idleTimeoutMs is still 0', () => {
    // The one thing supplying host timers could have changed by accident: a machine that
    // ended its own session after a quiet spell would drop the microphone mid-conversation.
    const built = machine(hostTimers());
    vi.advanceTimersByTime(600_000);
    expect(built.getState()).toBe('listening');
  });
});
