import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { attachMemory, FakeMemoryStore, MemoryKernel, MemoryStoreError, type AttachedMemory } from '@latentpresence/core';
import type { ConversationEvent, MemoryEpisode, SemanticFact } from '@latentpresence/protocol';
import { MemoryPanel } from './MemoryPanel';

afterEach(cleanup);

/** A machine the kernel's own tests use (`attach.test.ts`): nothing here needs it to fire
 * events, but `attachMemory` requires one to subscribe to. */
function bus() {
  const listeners = new Set<(event: ConversationEvent) => void>();
  return {
    subscribe(listener: (event: ConversationEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
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

function episode(id: string, sessionId: string, at: string, text: string, role: 'user' | 'assistant' = 'user'): MemoryEpisode {
  return { id, sessionId, characterId: 'alice', role, text, interrupted: false, at, embedding: null, affect: null };
}

/** Real kernel, real `attachMemory`, over a store the test controls — the brief's "no mocks
 * of the API". `sessionId` is one no test episode ever uses, so nothing is excluded by it. */
function makeMemory(store: FakeMemoryStore): { readonly memory: AttachedMemory; readonly kernel: MemoryKernel } {
  const kernel = new MemoryKernel({ store, characterId: 'alice', extractor: null });
  const memory = attachMemory(bus(), { kernel, sessionId: 'panel-under-test' });
  return { memory, kernel };
}

describe('MemoryPanel (P4-T05)', () => {
  it('with no memory, says it is off and links to Settings', () => {
    render(<MemoryPanel characterName="Alice" memory={null} where={null} />);
    expect(screen.getByText(/Memory is off/)).toBeTruthy();
    const link = screen.getByRole('link', { name: /Settings/ });
    expect(link.getAttribute('href')).toBe('/settings');
  });

  it('lists facts surest first', async () => {
    const store = new FakeMemoryStore();
    await store.upsertFact(fact('f1', 'tea', { confidence: 0.4 }));
    await store.upsertFact(fact('f2', 'coffee', { confidence: 0.9 }));
    const { memory } = makeMemory(store);
    render(<MemoryPanel characterName="Alice" memory={memory} where="this browser" />);

    await waitFor(() => expect(screen.getAllByText(/^user likes/)).toHaveLength(2));
    const lines = screen.getAllByText(/^user likes/).map((el) => el.textContent);
    expect(lines).toEqual(['user likes coffee', 'user likes tea (not sure)']);
  });

  it('edits a fact: Save writes the new object through the kernel', async () => {
    const store = new FakeMemoryStore();
    await store.upsertFact(fact('f1', 'tea'));
    const { memory } = makeMemory(store);
    render(<MemoryPanel characterName="Alice" memory={memory} where="this browser" />);

    await waitFor(() => screen.getByText('user likes tea'));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: /Edit user likes/ }), { target: { value: 'coffee' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.getByText(/^user likes coffee/)).toBeTruthy());
    expect(store.rows.facts.find((row) => row.fact.id === 'f1')?.fact.object).toBe('coffee');
  });

  it('asks before forgetting a fact; Cancel keeps it, Confirm removes it for good', async () => {
    const store = new FakeMemoryStore();
    await store.upsertFact(fact('f1', 'tea'));
    const { memory, kernel } = makeMemory(store);
    render(<MemoryPanel characterName="Alice" memory={memory} where="this browser" />);

    await waitFor(() => screen.getByText('user likes tea'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByText('Forget this for good?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('user likes tea')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(screen.queryByText('user likes tea')).toBeNull());

    // The done-when, through the UI: the next recall does not bring it back.
    const recalled = await kernel.recall({ sessionId: 'some-other-visit', query: 'tea' });
    expect(recalled.facts).toEqual([]);
  });

  it('groups conversations by session, newest session first, and Older pages until a page comes back short', async () => {
    const store = new FakeMemoryStore();
    const base = Date.parse('2026-09-01T00:00:00.000Z');
    for (let i = 0; i < 5; i += 1) {
      await store.appendEpisode(episode(`old-${i}`, 'session-old', new Date(base + i * 60_000).toISOString(), `old turn ${i}`));
    }
    for (let i = 0; i < 50; i += 1) {
      await store.appendEpisode(episode(`new-${i}`, 'session-new', new Date(base + 10_000_000 + i * 60_000).toISOString(), `new turn ${i}`));
    }
    const { memory } = makeMemory(store);
    render(<MemoryPanel characterName="Alice" memory={memory} where="this browser" />);

    await waitFor(() => expect(screen.getByText('new turn 0')).toBeTruthy());
    expect(screen.queryByText('old turn 0')).toBeNull();
    expect(screen.getByRole('button', { name: 'Older' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Older' }));
    await waitFor(() => expect(screen.getByText('old turn 0')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Older' })).toBeNull();
  });

  it('deletes a turn', async () => {
    const store = new FakeMemoryStore();
    await store.appendEpisode(episode('e1', 'session-1', '2026-09-01T00:00:00.000Z', 'hello there'));
    const { memory } = makeMemory(store);
    render(<MemoryPanel characterName="Alice" memory={memory} where="this browser" />);

    await waitFor(() => screen.getByText('hello there'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(screen.queryByText('hello there')).toBeNull());
  });

  it('search shows searchEpisodes results, with a way back to the full list', async () => {
    const store = new FakeMemoryStore();
    await store.appendEpisode(episode('e1', 'session-1', '2026-09-01T00:00:00.000Z', 'talked about the trip'));
    await store.appendEpisode(episode('e2', 'session-1', '2026-09-02T00:00:00.000Z', 'talked about dinner'));
    const { memory } = makeMemory(store);
    render(<MemoryPanel characterName="Alice" memory={memory} where="this browser" />);

    await waitFor(() => screen.getByText('talked about the trip'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Search conversations' }), { target: { value: 'trip' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    await waitFor(() => expect(screen.queryByText('talked about dinner')).toBeNull());
    expect(screen.getByText('talked about the trip')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Back to full list' }));
    await waitFor(() => expect(screen.getByText('talked about dinner')).toBeTruthy());
  });

  it('a store that throws on delete shows the message and keeps the rest of the panel', async () => {
    class ThrowingStore extends FakeMemoryStore {
      override async deleteFact(): Promise<void> {
        throw new MemoryStoreError('unavailable', 'no database reachable');
      }
    }
    const store = new ThrowingStore();
    await store.upsertFact(fact('f1', 'tea'));
    const { memory } = makeMemory(store);
    render(<MemoryPanel characterName="Alice" memory={memory} where="this browser" />);

    await waitFor(() => screen.getByText('user likes tea'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    // The section's error line says what went wrong; the row itself is not thrown away —
    // it is still there, mid-confirm, so Cancel gets back to it.
    await waitFor(() => expect(screen.getByText('no database reachable')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('user likes tea')).toBeTruthy();
  });
});
