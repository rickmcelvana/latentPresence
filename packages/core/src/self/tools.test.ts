import type { LLMProvider, LlmRequest, LlmStreamChunk, ToolCall } from '@latentpresence/protocol';
import { describe, expect, it } from 'vitest';
import { FakeMemoryStore } from '../memory/fake-store';
import { MAX_NOTES, SelfNotes } from './notes';
import { selfNoteTools, withLocalTools, type LocalTool } from './tools';

const AT = '2026-09-28T12:00:00.000Z';
/** The context a direct `run` gets: a call, no cancellation. */
const CTX = { call: { id: 'c', name: 'direct', arguments: {}, source: 'llm' as const, requestedAt: AT } };

function call(name: string, args: Record<string, string>, id = `call-${name}`): ToolCall {
  return { id, name, arguments: args, source: 'llm', requestedAt: AT };
}

/** A model that answers each request with the next scripted list of chunks, and keeps the requests. */
function scripted(rounds: readonly (readonly LlmStreamChunk[])[]): LLMProvider & { requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  return {
    id: 'scripted',
    requests,
    listModels: async () => [],
    async *stream(request) {
      requests.push(request);
      yield* rounds[requests.length - 1] ?? [{ type: 'finish', reason: 'stop', usage: null }];
    },
  };
}

const request: LlmRequest = { modelId: 'm', messages: [{ role: 'user', content: 'Call me Captain.' }], tools: [], temperature: null, maxOutputTokens: null };

async function collect(stream: AsyncIterable<LlmStreamChunk>): Promise<LlmStreamChunk[]> {
  const chunks: LlmStreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function notesOn(store = new FakeMemoryStore()) {
  return { store, notes: new SelfNotes({ store, characterId: 'alice', now: () => new Date(AT) }) };
}

/** One round that says `before` and calls a tool, and one that says `text` and then " Next." */
function toolRound(before: string) {
  return [
    { type: 'text-delta', text: before },
    { type: 'tool-call', call: call('self_read_block', { name: 'x' }) },
    { type: 'finish', reason: 'tool-calls', usage: null },
  ] as const;
}

function after(text: string) {
  return [{ type: 'text-delta', text }, { type: 'text-delta', text: ' Next.' }, { type: 'finish', reason: 'stop', usage: null }] as const;
}

describe('withLocalTools (P4-T06, ADR-40)', () => {
  it('is the provider itself when there are no tools', async () => {
    const llm = scripted([[{ type: 'text-delta', text: 'Hi.' }, { type: 'finish', reason: 'stop', usage: null }]]);
    const chunks = await collect(withLocalTools(llm, () => []).stream(request));
    expect(chunks.map((chunk) => chunk.type)).toEqual(['text-delta', 'finish']);
    expect(llm.requests[0]?.tools).toEqual([]);
  });

  it('runs a note the model writes, hands back the result, and streams what it says next', async () => {
    const { store, notes } = notesOn();
    const llm = scripted([
      [
        { type: 'text-delta', text: 'Aye, ' },
        { type: 'tool-call', call: call('self_write_block', { name: 'what_they_like', content: 'Wants to be called Captain. Hates small talk.' }) },
        { type: 'finish', reason: 'tool-calls', usage: null },
      ],
      [
        { type: 'text-delta', text: 'Captain.' },
        { type: 'finish', reason: 'stop', usage: null },
      ],
    ]);
    const seen: string[] = [];
    const chunks = await collect(withLocalTools(llm, () => selfNoteTools(notes), { onCall: (c) => seen.push(c.name) }).stream(request));

    expect(chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')).toBe('Aye, Captain.');
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: 'stop', usage: null });
    expect(chunks.some((chunk) => chunk.type === 'tool-call')).toBe(false); // the page's own business
    expect(seen).toEqual(['self_write_block']);
    expect(llm.requests[0]?.tools.map((tool) => tool.name)).toEqual(['self_read_block', 'self_write_block']);
    expect(llm.requests[1]?.messages.slice(-2)).toEqual([
      { role: 'assistant', content: 'Aye, ', toolCalls: [expect.objectContaining({ name: 'self_write_block' })] },
      { role: 'tool', callId: 'call-self_write_block', content: { saved: 'what_they_like' } },
    ]);
    expect((await store.readBlocks('alice')).map((block) => [block.name, block.content, block.editableByCharacter])).toEqual([
      ['what_they_like', 'Wants to be called Captain. Hates small talk.', true],
    ]);
  });

  it('puts a space between what was said before a call and after it when neither has one', async () => {
    const { notes } = notesOn();
    const said = async (before: string, next: string): Promise<string> => {
      const chunks = await collect(withLocalTools(scripted([toolRound(before), after(next)]), () => selfNoteTools(notes)).stream(request));
      return chunks.flatMap((chunk) => (chunk.type === 'text-delta' ? [chunk.text] : [])).join('');
    };
    expect(await said('Let me lay it out.', 'So I have saved it.')).toBe('Let me lay it out. So I have saved it. Next.');
    expect(await said('Aye, ', 'Captain.')).toBe('Aye, Captain. Next.');
    expect(await said('Right.', '\nSaved.')).toBe('Right.\nSaved. Next.');
    expect(await said('', 'Saved.')).toBe('Saved. Next.');
  });

  it('offers no tools on the last round, so an answer always ends in words', async () => {
    const { notes } = notesOn();
    const again = [{ type: 'tool-call', call: call('self_read_block', { name: 'x' }) }, { type: 'finish', reason: 'tool-calls', usage: null }] as const;
    const llm = scripted([again, again, [{ type: 'text-delta', text: 'Fine.' }, { type: 'finish', reason: 'stop', usage: null }]]);
    const chunks = await collect(withLocalTools(llm, () => selfNoteTools(notes), { maxRounds: 2 }).stream(request));
    expect(llm.requests.map((r) => r.tools.length)).toEqual([2, 2, 0]);
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: 'stop', usage: null });
  });

  it('tells a model that calls her tool on the last round anyway to answer, and gives it one round to (P5-T02)', async () => {
    const { notes } = notesOn();
    const again = [{ type: 'tool-call', call: call('self_read_block', { name: 'x' }) }, { type: 'finish', reason: 'tool-calls', usage: null }] as const;
    const llm = scripted([again, again, again, [{ type: 'text-delta', text: 'Here is what I found.' }, { type: 'finish', reason: 'stop', usage: null }]]);
    const ran: string[] = [];
    const chunks = await collect(withLocalTools(llm, () => selfNoteTools(notes), { maxRounds: 2, onCall: (c) => ran.push(c.name) }).stream(request));
    expect(llm.requests.map((r) => r.tools.length)).toEqual([2, 2, 0, 0]);
    expect(ran).toHaveLength(2);
    expect(llm.requests[3]?.messages.at(-1)).toEqual({ role: 'tool', callId: 'call-self_read_block', content: { error: expect.stringContaining('Answer now') } });
    expect(chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')).toBe('Here is what I found.');
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: 'stop', usage: null });

    // And when it calls one even then, the answer ends — as a stop, never a call nobody runs.
    const stubborn = scripted([again, again, again, again]);
    const last = await collect(withLocalTools(stubborn, () => selfNoteTools(notes), { maxRounds: 2 }).stream(request));
    expect(stubborn.requests).toHaveLength(4);
    expect(last).toEqual([{ type: 'finish', reason: 'stop', usage: null }]);
  });

  it('turns a tool that throws, or one that does not exist, into a result the model reads', async () => {
    const broken: LocalTool = {
      definition: { name: 'broken', description: '', parameters: { type: 'object' } },
      run: () => Promise.reject(new Error('disk full')),
    };
    const llm = scripted([
      [{ type: 'tool-call', call: call('broken', {}) }, { type: 'finish', reason: 'tool-calls', usage: null }],
      [{ type: 'text-delta', text: 'Sorry.' }, { type: 'finish', reason: 'stop', usage: null }],
    ]);
    await collect(withLocalTools(llm, () => [broken]).stream(request));
    expect(llm.requests[1]?.messages.at(-1)).toEqual({ role: 'tool', callId: 'call-broken', content: { error: 'disk full' } });
  });

  it('passes through a tool call that is not one of its own', async () => {
    const { notes } = notesOn();
    const foreign = call('mcp_weather', { city: 'Halifax' });
    const llm = scripted([[{ type: 'tool-call', call: foreign }, { type: 'finish', reason: 'tool-calls', usage: null }]]);
    const chunks = await collect(withLocalTools(llm, () => selfNoteTools(notes)).stream(request));
    expect(chunks).toEqual([{ type: 'tool-call', call: foreign }, { type: 'finish', reason: 'tool-calls', usage: null }]);
    expect(llm.requests).toHaveLength(1);
  });
});

describe('selfNoteTools', () => {
  it('reads a note back, and names the notes there are when asked for one that is not', async () => {
    const { notes } = notesOn();
    const [read, write] = selfNoteTools(notes);
    await write!.run({ name: 'about_me', content: 'I like quiet mornings.' }, CTX);
    expect(await read!.run({ name: 'about_me' }, CTX)).toEqual({ name: 'about_me', content: 'I like quiet mornings.' });
    expect(await read!.run({ name: 'nope' }, CTX)).toEqual({ error: 'You have no note called "nope".', notes: ['about_me'] });
    expect(await read!.run({}, CTX)).toEqual({ error: 'Give the name of the note to read.' });
  });

  it('reads the store again after a failed first read (R-27)', async () => {
    const { store, notes } = notesOn();
    const readBlocks = store.readBlocks.bind(store);
    store.readBlocks = async () => {
      throw new TypeError('Failed to fetch');
    };
    await expect(notes.writeNote('about_me', 'Quiet mornings.')).rejects.toThrow('Failed to fetch');
    store.readBlocks = readBlocks;
    expect(await notes.writeNote('about_me', 'Quiet mornings.')).toEqual({ ok: true });
  });

  it('refuses, in words, a system name, a bad name, a locked note, a long note and a ninth note', async () => {
    const { store, notes } = notesOn();
    await store.writeBlock({ characterId: 'alice', name: 'boundaries', content: 'No medical advice.', updatedAt: AT, editableByCharacter: false });
    const [, write] = selfNoteTools(notes);
    const refused = async (args: Record<string, string>) => ((await write!.run(args, CTX)) as { error?: string }).error ?? null;
    expect(await refused({ name: '_mood', content: 'happy' })).toMatch(/not a name you can use/u);
    expect(await refused({ name: 'Has Spaces', content: 'x' })).toMatch(/not a name you can use/u);
    expect(await refused({ name: 'boundaries', content: 'Anything goes.' })).toMatch(/only the person can change/u);
    expect(await refused({ name: 'long', content: 'x'.repeat(2001) })).toMatch(/Say it shorter/u);
    for (let i = 0; i < MAX_NOTES - 1; i += 1) expect(await refused({ name: `note_${i}`, content: 'x' })).toBeNull();
    expect(await refused({ name: 'one_too_many', content: 'x' })).toMatch(/Rewrite one of them instead/u);
    expect(await refused({ name: 'note_0', content: 'rewritten' })).toBeNull();
    expect((await store.readBlocks('alice')).find((block) => block.name === 'boundaries')?.content).toBe('No medical advice.');
  });
});
