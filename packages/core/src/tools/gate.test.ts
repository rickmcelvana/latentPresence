import { describe, expect, it } from 'vitest';
import { ManualTimers, manualSignal } from '../testing/timers';
import { PERMISSION_TIMEOUT_MS, PermissionPrompts, effectivePolicy, toolFingerprint } from './gate';

const TOOL = { description: 'Read a wiki.', inputSchema: { type: 'object', properties: { repo: { type: 'string' } } } };
const REQUEST = { serverId: 's1', serverName: 'DeepWiki', tool: 'read_wiki', description: 'Read a wiki.', args: { repo: 'vercel/ai' }, changed: false };

describe('the tool policy (P5-T01, ADR-42)', () => {
  it('asks about a tool nobody has decided about', () => {
    expect(effectivePolicy(undefined, TOOL)).toEqual({ policy: 'ask', changed: false });
  });

  it('keeps never and ask as set, and auto while the tool is what was trusted', () => {
    expect(effectivePolicy({ policy: 'never', fingerprint: null }, TOOL).policy).toBe('never');
    expect(effectivePolicy({ policy: 'ask', fingerprint: null }, TOOL).policy).toBe('ask');
    expect(effectivePolicy({ policy: 'auto', fingerprint: toolFingerprint(TOOL) }, TOOL)).toEqual({ policy: 'auto', changed: false });
  });

  it('asks again, and says so, when a trusted tool changes what it says it does', () => {
    const trusted = { policy: 'auto' as const, fingerprint: toolFingerprint(TOOL) };
    expect(effectivePolicy(trusted, { ...TOOL, description: 'Deletes a wiki.' })).toEqual({ policy: 'ask', changed: true });
    expect(effectivePolicy(trusted, { ...TOOL, inputSchema: { type: 'object', properties: { repo: { type: 'string' }, force: { type: 'boolean' } } } }).changed).toBe(true);
  });

  it('fingerprints by content, not key order', () => {
    expect(toolFingerprint({ description: 'x', inputSchema: { a: 1, b: { c: 2, d: 3 } } })).toBe(toolFingerprint({ description: 'x', inputSchema: { b: { d: 3, c: 2 }, a: 1 } }));
    expect(toolFingerprint(TOOL)).toMatch(/^[0-9a-f]{8}$/u);
  });
});

describe('PermissionPrompts', () => {
  it('waits for the person, shows the ask while it waits, and takes the answer', async () => {
    const timers = new ManualTimers();
    const prompts = new PermissionPrompts({ timers, now: () => new Date('2026-09-30T12:00:00Z') });
    const seen: number[] = [];
    prompts.subscribe(() => seen.push(prompts.snapshot().length));
    const asked = prompts.ask(REQUEST);
    expect(prompts.snapshot()).toEqual([{ ...REQUEST, id: 'ask-1', at: '2026-09-30T12:00:00.000Z' }]);
    expect(timers.delays()).toEqual([PERMISSION_TIMEOUT_MS]);
    prompts.answer('ask-1', 'always');
    expect(await asked).toEqual({ decision: 'always' });
    expect(prompts.snapshot()).toEqual([]);
    expect(timers.size).toBe(0);
    expect(seen).toEqual([1, 0]);
  });

  it('refuses when nobody answers in time, and when the answer is stopped', async () => {
    const timers = new ManualTimers();
    const prompts = new PermissionPrompts({ timers });
    const late = prompts.ask(REQUEST);
    timers.fireAll();
    expect(await late).toEqual({ decision: 'deny', reason: 'timeout' });

    const signal = manualSignal();
    const stopped = prompts.ask(REQUEST, signal);
    signal.abort();
    expect(await stopped).toEqual({ decision: 'deny', reason: 'stopped' });
    expect(prompts.snapshot()).toEqual([]);
    expect(await prompts.ask(REQUEST, signal)).toEqual({ decision: 'deny', reason: 'stopped' });
  });

  it('keeps several asks apart and ignores an answer to one already settled', async () => {
    const prompts = new PermissionPrompts({ timers: new ManualTimers() });
    const first = prompts.ask(REQUEST);
    const second = prompts.ask({ ...REQUEST, tool: 'ask_question' });
    prompts.answer('ask-2', 'deny');
    prompts.answer('ask-2', 'once');
    prompts.answer('ask-1', 'once');
    expect(await first).toEqual({ decision: 'once' });
    expect(await second).toEqual({ decision: 'deny' });
  });
});
