import { describe, expect, it } from 'vitest';
import type { ConversationEvent } from '@latentpresence/protocol';
import { ConversationMachine, type ConversationMachineOptions, type Scheduler } from './machine';
import type { Ports } from './ports';

const AT = '2026-09-11T00:00:00.000Z';

/** Deterministic wall clock for the machine's own event timestamps. */
const now = () => AT;

const sessionId = 'session-p1-t01';
const characterId = 'alice';

/** External events the machine consumes, built at the right shape for the union. */
const speechStarted = { sessionId, at: AT, type: 'user.speech.started' } as const;
const turnEnded = { sessionId, at: AT, type: 'user.turn.ended', probability: 0.9 } as const;
const userMessage = { sessionId, at: AT, type: 'user.message', text: 'hello' } as const;
const userTranscript = { sessionId, at: AT, type: 'user.transcript', text: 'hi', isFinal: false, confidence: null } as const;
const audioStarted = { sessionId, at: AT, type: 'assistant.audio.started', sentenceIndex: 0 } as const;
const audioEnded = { sessionId, at: AT, type: 'assistant.audio.ended', sentenceIndex: 0 } as const;
const token = { sessionId, at: AT, type: 'assistant.token', text: 'He' } as const;

/** A controllable scheduler: timers only fire when `runAll` is called. */
function fakeScheduler() {
  const queue: Array<{ fn: () => void; cleared: boolean }> = [];
  let count = 0;
  const scheduler: Scheduler = {
    setTimeout(fn) {
      const item = { fn, cleared: false };
      queue.push(item);
      count += 1;
      return item;
    },
    clearTimeout(handle) {
      (handle as { cleared: boolean }).cleared = true;
    },
  };
  return {
    scheduler,
    scheduledCount: () => count,
    runAll() {
      for (const item of Array.from(queue)) {
        if (!item.cleared) item.fn();
      }
    },
  };
}

function makeMachine(options?: Partial<ConversationMachineOptions>) {
  const machine = new ConversationMachine({
    sessionId,
    characterId,
    now,
    ...options,
  });
  const transitions: string[] = [];
  const events: ConversationEvent[] = [];
  const unsubscribe = machine.subscribe((event) => {
    events.push(event);
    if (event.type === 'state.changed') transitions.push(`${event.from}>${event.to}`);
  });
  return { machine, transitions, events, unsubscribe };
}

describe('ConversationMachine lifecycle', () => {
  it('begins in idle', () => {
    const { machine } = makeMachine();
    expect(machine.getState()).toBe('idle');
  });

  it('start() emits session.started then moves idle → listening', () => {
    const { machine, events, transitions } = makeMachine();
    machine.start();
    expect(events.map((e) => e.type)).toEqual(['session.started', 'state.changed']);
    expect(transitions).toEqual(['idle>listening']);
    expect(machine.getState()).toBe('listening');
  });

  it('end() emits session.ended and returns to idle', () => {
    const { machine, transitions } = makeMachine();
    machine.start();
    machine.end('user');
    expect([...transitions]).toEqual(['idle>listening', 'listening>idle']);
    expect(machine.getState()).toBe('idle');
  });
});

describe('ConversationMachine happy path', () => {
  it('listening → thinking → speaking on a normal turn', () => {
    const { machine, transitions } = makeMachine();
    machine.start();
    machine.dispatch(turnEnded);
    expect(machine.getState()).toBe('thinking');
    machine.dispatch(audioStarted);
    expect(machine.getState()).toBe('speaking');
    expect(transitions).toEqual(['idle>listening', 'listening>thinking', 'thinking>speaking']);
  });

  it('returns to listening when the turn ends naturally', () => {
    const { machine, transitions } = makeMachine();
    machine.start();
    machine.dispatch(turnEnded);
    machine.dispatch(audioStarted);
    machine.dispatch(audioEnded);
    expect(machine.getState()).toBe('listening');
    expect(transitions).toContain('speaking>listening');
  });

  it('a typed message drives idle → thinking directly', () => {
    const { machine } = makeMachine();
    machine.dispatch(userMessage);
    expect(machine.getState()).toBe('thinking');
  });
});

describe('ConversationMachine barge-in (P1-T01)', () => {
  it('barges in during thinking straight back to listening', () => {
    const { machine, transitions } = makeMachine();
    machine.start();
    machine.dispatch(turnEnded); // -> thinking
    expect(machine.getState()).toBe('thinking');
    machine.dispatch(speechStarted);
    expect(machine.getState()).toBe('listening');
    expect(transitions).toContain('thinking>listening');
  });

  it('barges in during speaking into interrupted, then teardown returns to listening', () => {
    const fake = fakeScheduler();
    const { machine, transitions } = makeMachine({ scheduler: fake.scheduler });
    machine.start();
    machine.dispatch(turnEnded); // -> thinking
    machine.dispatch(audioStarted); // -> speaking
    machine.dispatch(speechStarted); // -> interrupted
    expect(machine.getState()).toBe('interrupted');
    expect(transitions).toContain('speaking>interrupted');

    fake.runAll(); // the fade-out teardown completes
    expect(machine.getState()).toBe('listening');
    expect(transitions).toContain('interrupted>listening');
  });

  it('treats a complete interjection as its own turn before the teardown fires', () => {
    const fake = fakeScheduler();
    const { machine, transitions } = makeMachine({ scheduler: fake.scheduler });
    machine.start();
    machine.dispatch(turnEnded);
    machine.dispatch(audioStarted);
    machine.dispatch(speechStarted); // -> interrupted
    // The user's interjection is already a complete short turn.
    machine.dispatch(turnEnded);
    expect(machine.getState()).toBe('thinking');
    expect(transitions).toContain('interrupted>thinking');

    // The stale teardown timer must not yank the machine back once it has moved on.
    fake.runAll();
    expect(machine.getState()).toBe('thinking');
  });
});

describe('ConversationMachine timers', () => {
  it('auto-ends an idle listening session', () => {
    const fake = fakeScheduler();
    const { machine, events } = makeMachine({ scheduler: fake.scheduler, idleTimeoutMs: 1000 });
    machine.start();
    fake.runAll();
    expect(machine.getState()).toBe('idle');
    expect(events.some((e) => e.type === 'session.ended' && e.reason === 'idle')).toBe(true);
  });

  it('resets the idle timer on any listening activity', () => {
    const fake = fakeScheduler();
    const { machine } = makeMachine({ scheduler: fake.scheduler, idleTimeoutMs: 1000 });
    machine.start();
    expect(fake.scheduledCount()).toBe(1);
    machine.dispatch(userTranscript); // pass-through, stays listening -> resets the timer
    expect(fake.scheduledCount()).toBe(2);
  });

  it('schedules a teardown timer for each interrupted entry', () => {
    const fake = fakeScheduler();
    const { machine } = makeMachine({ scheduler: fake.scheduler });
    machine.start();
    machine.dispatch(turnEnded);
    machine.dispatch(audioStarted);
    machine.dispatch(speechStarted); // -> interrupted, schedules teardown
    expect(fake.scheduledCount()).toBe(1);
  });
});

describe('ConversationMachine bus and ports', () => {
  it('passes non-transitioning events through the bus', () => {
    const { machine, events } = makeMachine();
    machine.start();
    machine.dispatch(token); // assistant.token does not move state
    expect(events.map((e) => e.type)).toContain('assistant.token');
    expect(machine.getState()).toBe('listening');
  });

  it('exposes the ports it was given and nothing by default', () => {
    const ports: Ports = { audioIn: { start() {}, stop() {} } };
    const { machine } = makeMachine({ ports });
    expect(machine.getPorts()).toBe(ports);

    const bare = makeMachine().machine;
    expect(bare.getPorts()).toEqual({});
  });

  it('stops delivering to an unsubscribed listener', () => {
    const { machine, unsubscribe, events } = makeMachine();
    const before = events.length;
    unsubscribe();
    machine.start();
    expect(events.length).toBe(before);
  });
});
