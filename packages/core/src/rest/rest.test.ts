import type { ConversationEvent, SemanticFact } from '@latentpresence/protocol';
import { describe, expect, it } from 'vitest';
import { Cancellation } from '../cancellation';
import { ConversationMachine } from '../conversation/machine';
import type { SleepReport } from '../memory/kernel';
import { settle } from '../testing/scripted';
import { REST_AFTER_MS, attachRest, hasSomethingToSort } from './rest';

const MINUTE = 60_000;
const NOW = Date.parse('2026-10-12T20:00:00.000Z');

function fact(id: string, recordedAt: string): SemanticFact {
  return { id, characterId: 'alice', subject: 'user', predicate: 'likes', object: id, confidence: 0.9, validFrom: recordedAt, validTo: null, recordedAt, sourceEpisodeId: null, embedding: null };
}

const REPORT: SleepReport = { before: 3, after: 2, mergedByRule: 1, mergedByModel: 0, consolidated: null, stopped: false };

function rig(options: { facts?: SemanticFact[]; lastSlept?: string | null; sleep?: (signal: Cancellation | undefined) => Promise<SleepReport> } = {}) {
  let clock = NOW;
  const machine = new ConversationMachine({ sessionId: 's', characterId: 'alice', now: () => new Date(clock).toISOString() });
  machine.start();
  const block = { text: options.lastSlept ?? null };
  const sleeps: (Cancellation | undefined)[] = [];
  let typing = false;
  const rest = attachRest(machine, {
    kernel: {
      knownFacts: async () => options.facts ?? [fact('a', '2026-10-12T19:00:00.000Z'), fact('b', '2026-10-12T19:01:00.000Z')],
      sleep: async ({ signal }) => {
        sleeps.push(signal);
        return options.sleep === undefined ? REPORT : options.sleep(signal);
      },
    },
    blocked: () => typing,
    ledger: {
      read: () => block.text,
      write: async (text) => {
        block.text = text;
      },
    },
    now: () => clock,
  });
  const dispatch = (event: Record<string, unknown>): void => machine.dispatch({ ...event, sessionId: 's', at: new Date(clock).toISOString() } as unknown as ConversationEvent);
  return { rest, block, sleeps, dispatch, advance: (ms: number) => (clock += ms), setTyping: (value: boolean) => (typing = value) };
}

describe('attachRest (P6-T04, ADR-53)', () => {
  it('rests after ten quiet minutes when there is something new, sleeps on it, and remembers when', async () => {
    const r = rig();
    const seen: boolean[] = [];
    r.rest.subscribe((resting) => seen.push(resting));
    r.advance(REST_AFTER_MS - MINUTE);
    expect(await r.rest.tick()).toBe(false);
    r.advance(MINUTE);
    expect(await r.rest.tick()).toBe(true);
    expect(r.rest.resting()).toBe(true);
    await settle();
    expect(r.sleeps).toHaveLength(1);
    expect(r.block.text).toBe(new Date(NOW + REST_AFTER_MS).toISOString());
    // Still resting once the sleep is done: until someone is there.
    expect(r.rest.resting()).toBe(true);
    expect(seen).toEqual([true]);
  });

  it('wakes on anything on the bus or a key, and stops a sleep still running', async () => {
    const pending: { finish: () => void } = { finish: () => undefined };
    const r = rig({
      sleep: (signal) =>
        new Promise((resolve) => {
          pending.finish = () => resolve({ ...REPORT, stopped: signal?.aborted === true });
        }),
    });
    r.advance(REST_AFTER_MS);
    await r.rest.tick();
    r.dispatch({ type: 'user.speech.started' });
    expect(r.rest.resting()).toBe(false);
    expect(r.sleeps[0]?.aborted).toBe(true);
    pending.finish();
    await settle();
    // Stopped part way: last slept is not moved, so it sorts the rest next time.
    expect(r.block.text).toBeNull();

    r.advance(REST_AFTER_MS);
    await r.rest.tick();
    r.rest.wake();
    expect(r.rest.resting()).toBe(false);
  });

  it('does not rest while they type, while she is busy, or with nothing new to sort', async () => {
    const typing = rig();
    typing.advance(REST_AFTER_MS);
    typing.setTyping(true);
    expect(await typing.rest.tick()).toBe(false);

    const busy = rig();
    busy.dispatch({ type: 'user.message', text: 'hi' });
    busy.advance(REST_AFTER_MS);
    expect(await busy.rest.tick()).toBe(false);

    const nothing = rig({ lastSlept: '2026-10-12T19:30:00.000Z' });
    nothing.advance(REST_AFTER_MS);
    expect(await nothing.rest.tick()).toBe(false);
  });

  it('counts as new only facts recorded since she last slept; never slept, two facts will do', () => {
    const facts = [fact('a', '2026-10-12T19:00:00.000Z'), fact('b', '2026-10-12T19:40:00.000Z')];
    expect(hasSomethingToSort(facts, '2026-10-12T19:30:00.000Z')).toBe(true);
    expect(hasSomethingToSort(facts, '2026-10-12T19:45:00.000Z')).toBe(false);
    expect(hasSomethingToSort(facts, null)).toBe(true);
    expect(hasSomethingToSort(facts.slice(0, 1), null)).toBe(false);
  });
});
