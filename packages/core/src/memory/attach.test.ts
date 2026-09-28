import type { ConversationEvent, SemanticFact, UserAffect } from '@latentpresence/protocol';
import { describe, expect, it } from 'vitest';
import { attachMemory, promptFacts } from './attach';
import { FakeMemoryStore } from './fake-store';
import { RecordedLLM } from './fixtures/replay';
import { MemoryKernel } from './kernel';

const AT = '2026-09-28T10:00:00.000Z';
const NOW = () => new Date('2026-09-28T10:05:00.000Z');

/** `Omit` over a discriminated union collapses it; this keeps the variants apart. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type BusEvent = DistributiveOmit<ConversationEvent, 'sessionId' | 'at'>;

function bus() {
  const listeners = new Set<(event: ConversationEvent) => void>();
  return {
    subscribe(listener: (event: ConversationEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send(event: BusEvent) {
      for (const listener of listeners) listener({ ...event, sessionId: 'visit-2', at: AT } as ConversationEvent);
    },
    get size() {
      return listeners.size;
    },
  };
}

function fact(id: string, object: string, overrides: Partial<SemanticFact> = {}): SemanticFact {
  return {
    id,
    characterId: 'alice',
    subject: 'user',
    predicate: 'likes',
    object,
    confidence: 0.8,
    validFrom: '2026-09-01T00:00:00.000Z',
    validTo: null,
    recordedAt: '2026-09-01T00:00:00.000Z',
    sourceEpisodeId: null,
    embedding: null,
    ...overrides,
  };
}

function setup(options: { store?: FakeMemoryStore; replies?: readonly string[]; userAffect?: () => UserAffect | null } = {}) {
  const store = options.store ?? new FakeMemoryStore({ now: NOW });
  const llm = new RecordedLLM(options.replies ?? []);
  const kernel = new MemoryKernel({ store, characterId: 'alice', extractor: options.replies ? { llm, modelId: 'm' } : null, now: NOW });
  const machine = bus();
  const errors: Error[] = [];
  let ids = 0;
  const memory = attachMemory(machine, {
    kernel,
    sessionId: 'visit-2',
    newId: () => `id-${(ids += 1)}`,
    ...(options.userAffect ? { userAffect: options.userAffect } : {}),
    onError: (error) => errors.push(error),
  });
  return { store, machine, memory, kernel, errors, llm };
}

const PRIYA = '{"facts":[{"subject":"user","predicate":"sister_name","object":"Priya","confidence":0.9,"validFrom":null,"replaces":null}],"ended":[]}';

describe('attachMemory (P4-T04b)', () => {
  it('has nothing to say for someone it has never met, and waits for nothing to say so', () => {
    const { memory } = setup();
    expect(memory.context()).toBeNull();
  });

  it('carries what was already known from the first turn, without a query', async () => {
    const store = new FakeMemoryStore({ now: NOW });
    await store.upsertFact(fact('f1', 'marmalade'));
    const { memory } = setup({ store });
    await memory.settled();
    expect(memory.context()?.facts.map((row) => row.object)).toEqual(['marmalade']);
    expect(memory.context()?.episodes).toEqual([]);
  });

  it('keeps each user message with how they seemed, and each answer as it was heard', async () => {
    const affect: UserAffect = { valence: 0.6, arousal: 0.4, confidence: 0.8, label: 'happy', readings: [], at: AT };
    const { store, machine, memory } = setup({ userAffect: () => affect });
    machine.send({ type: 'user.message', text: 'Tell me a long story' });
    machine.send({ type: 'assistant.message', entry: { id: 'a0', role: 'assistant', text: '\n\n ', at: AT, spokenPrefix: null } });
    machine.send({ type: 'assistant.message', entry: { id: 'a1', role: 'assistant', text: 'Once upon a time there was a fox.', at: AT, spokenPrefix: 'Once upon a ' } });
    machine.send({ type: 'assistant.backchannel', text: 'mm' });
    await memory.settled();
    const episodes = store.rows.episodes.map(({ episode }) => episode);
    expect(episodes.map((row) => [row.role, row.text, row.interrupted, row.sessionId])).toEqual([
      ['user', 'Tell me a long story', false, 'visit-2'],
      ['assistant', 'Once upon a', true, 'visit-2'],
    ]);
    expect(episodes[0]?.affect?.label).toBe('happy');
  });

  it('learns a fact from an exchange and carries it into the next request', async () => {
    const { machine, memory } = setup({ replies: [PRIYA] });
    machine.send({ type: 'user.message', text: 'My sister Priya is visiting' });
    machine.send({ type: 'assistant.message', entry: { id: 'a1', role: 'assistant', text: 'How lovely!', at: AT, spokenPrefix: null } });
    await memory.settled();
    expect(memory.context()?.facts.map((row) => `${row.predicate} ${row.object}`)).toEqual(['sister_name Priya']);
  });

  it('recalls an earlier visit after a user message, leaving this visit out', async () => {
    const store = new FakeMemoryStore({ now: NOW });
    const earlier = { sessionId: 'visit-1', characterId: 'alice', interrupted: false, at: '2026-09-20T10:00:00.000Z', embedding: null, affect: null } as const;
    await store.appendEpisode({ ...earlier, id: 'e1', role: 'user', text: 'The allotment flooded again' });
    await store.appendEpisode({ ...earlier, id: 'e2', role: 'user', text: 'Something else entirely' });
    const { machine, memory } = setup({ store });
    machine.send({ type: 'user.message', text: 'How is my allotment doing, do you think?' });
    await memory.settled();
    expect(memory.context()?.episodes.map((row) => row.text)).toEqual(['The allotment flooded again']);
  });

  it('keeps the recall for a message while the answer to it is being written', async () => {
    const store = new FakeMemoryStore({ now: NOW });
    await store.appendEpisode({ id: 'e1', sessionId: 'visit-1', characterId: 'alice', role: 'user', text: 'The allotment flooded', interrupted: false, at: '2026-09-20T10:00:00.000Z', embedding: null, affect: null });
    const { machine, memory } = setup({ store });
    machine.send({ type: 'user.message', text: 'my allotment' });
    // The answer arrives before the recall has resolved; re-reading the facts must not drop it.
    machine.send({ type: 'assistant.message', entry: { id: 'a1', role: 'assistant', text: 'Oh no.', at: AT, spokenPrefix: null } });
    await memory.settled();
    expect(memory.context()?.episodes.map((row) => row.text)).toEqual(['The allotment flooded']);
  });

  it('keeps the note it had when the store fails, and says so', async () => {
    const store = new FakeMemoryStore({ now: NOW });
    await store.upsertFact(fact('f1', 'marmalade'));
    const { machine, memory, errors } = setup({ store });
    await memory.settled();
    store.retrieve = () => Promise.reject(new Error('the companion went away'));
    machine.send({ type: 'user.message', text: 'marmalade' });
    await memory.settled();
    expect(errors.map((error) => error.message)).toContain('the companion went away');
    expect(memory.context()?.facts.map((row) => row.object)).toEqual(['marmalade']);
  });

  it('a fact the person deletes is gone from the next retrieval and the next prompt (P4-T05 done-when)', async () => {
    const store = new FakeMemoryStore({ now: NOW });
    await store.upsertFact(fact('f1', 'marmalade on toast'));
    await store.upsertFact(fact('f2', 'marmalade cake'));
    const { machine, memory } = setup({ store });
    machine.send({ type: 'user.message', text: 'marmalade' });
    await memory.settled();
    expect(memory.context()?.facts.map((row) => row.id).toSorted()).toEqual(['f1', 'f2']);

    await memory.deleteFact('f1');
    expect(memory.context()?.facts.map((row) => row.id)).toEqual(['f2']);
    const next = await memory.kernel.recall({ sessionId: 'visit-3', query: 'marmalade' });
    expect(next.facts.map((row) => row.id)).toEqual(['f2']);
    expect(store.rows.facts.map((row) => row.fact.id)).toEqual(['f2']);
  });

  it('a corrected fact is written in place, certain, and is what the prompt carries', async () => {
    const store = new FakeMemoryStore({ now: NOW });
    await store.upsertFact(fact('f1', 'lives in Toronto', { predicate: 'lives_in', object: 'Toronto', confidence: 0.6 }));
    const { memory } = setup({ store });
    await memory.settled();
    await memory.correctFact({ ...fact('f1', ''), predicate: 'lives_in', object: 'Halifax' });
    expect(memory.context()?.facts.map((row) => [row.object, row.confidence])).toEqual([['Halifax', 1]]);
    expect((await store.currentFacts('alice')).map((row) => row.object)).toEqual(['Halifax']);
  });

  it('a turn the person deletes leaves the note and the store', async () => {
    const store = new FakeMemoryStore({ now: NOW });
    await store.appendEpisode({ id: 'e1', sessionId: 'visit-1', characterId: 'alice', role: 'user', text: 'The allotment flooded', interrupted: false, at: '2026-09-20T10:00:00.000Z', embedding: null, affect: null });
    const { machine, memory } = setup({ store });
    machine.send({ type: 'user.message', text: 'allotment' });
    await memory.settled();
    expect(memory.context()?.episodes.map((row) => row.id)).toEqual(['e1']);
    await memory.deleteEpisode('e1');
    expect(memory.context()).toBeNull();
    expect(await memory.kernel.listEpisodes(null)).toEqual(expect.not.arrayContaining([expect.objectContaining({ id: 'e1' })]));
  });

  it('says what the last request was given, and when', async () => {
    const store = new FakeMemoryStore({ now: NOW });
    await store.upsertFact(fact('f1', 'marmalade'));
    const { memory } = setup({ store });
    expect(memory.lastInjected()).toBeNull();
    await memory.settled();
    const given = memory.context();
    expect(memory.lastInjected()?.memory).toEqual(given);
  });

  it('lists and searches turns across every session for the browser', async () => {
    const store = new FakeMemoryStore({ now: NOW });
    await store.appendEpisode({ id: 'e1', sessionId: 'visit-1', characterId: 'alice', role: 'user', text: 'The allotment flooded', interrupted: false, at: '2026-09-20T10:00:00.000Z', embedding: null, affect: null });
    const { machine, memory } = setup({ store });
    machine.send({ type: 'user.message', text: 'Talking about the allotment now' });
    await memory.settled();
    expect((await memory.kernel.listEpisodes(null)).map((row) => row.text)).toEqual(['Talking about the allotment now', 'The allotment flooded']);
    expect((await memory.kernel.searchEpisodes('allotment')).map((row) => row.sessionId).toSorted()).toEqual(['visit-1', 'visit-2']);
  });

  it('stops listening when detached', () => {
    const { machine, memory } = setup();
    expect(machine.size).toBe(1);
    memory.detach();
    expect(machine.size).toBe(0);
  });
});

describe('promptFacts', () => {
  const known = [fact('a', 'tea', { confidence: 0.5 }), fact('b', 'coffee', { confidence: 0.9 }), fact('c', 'cocoa', { confidence: 0.9, recordedAt: '2026-09-20T00:00:00.000Z' })];

  it('puts the recalled first, then the surest and the newest, up to the limit', () => {
    expect(promptFacts([known[0]!], known, 3).map((row) => row.id)).toEqual(['a', 'c', 'b']);
    expect(promptFacts([], known, 2).map((row) => row.id)).toEqual(['c', 'b']);
  });

  it('leaves out a recalled fact the kernel has since closed, and takes the current form of one it has changed', () => {
    const closed = fact('gone', 'lives in Toronto');
    const changed = { ...known[1]!, confidence: 0.99 };
    expect(promptFacts([closed, known[1]!], [known[0]!, changed], 5).map((row) => [row.id, row.confidence])).toEqual([
      ['b', 0.99],
      ['a', 0.5],
    ]);
  });
});
