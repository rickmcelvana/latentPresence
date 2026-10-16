import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { InMemoryBodyShelf, IndexedDbBodyShelf, isOwnBodyId, type BodyShelf } from './body-shelf';
import { BUILT_IN_BODIES, PLACEHOLDER_BODY_ID, bodyFor } from './bodies';

const described = { name: 'Mine', fileName: 'mine.vrm', bytes: 3, authors: ['Me'], missing: ['blink'] };

describe.each<[string, () => BodyShelf]>([
  ['IndexedDbBodyShelf', () => new IndexedDbBodyShelf(new IDBFactory())],
  ['InMemoryBodyShelf', () => new InMemoryBodyShelf()],
])('%s (P7-T02, ADR-59)', (_name, make) => {
  it('keeps a body and its exact bytes, and lists it without them', async () => {
    const shelf = make();
    // A view on a larger buffer: only its own three bytes are the file.
    const data = new Uint8Array([9, 1, 2, 3, 9]).subarray(1, 4);
    const kept = await shelf.add(described, data);

    expect(isOwnBodyId(kept.id)).toBe(true);
    expect(await shelf.list()).toEqual([kept]);
    expect([...(await shelf.read(kept.id))]).toEqual([1, 2, 3]);
  });

  it('removes a body whole, and says so when asked for it again', async () => {
    const shelf = make();
    const kept = await shelf.add(described, new Uint8Array([1, 2, 3]));
    await shelf.remove(kept.id);

    expect(await shelf.list()).toEqual([]);
    await expect(shelf.read(kept.id)).rejects.toThrow('That body is no longer in this browser.');
  });
});

describe('IndexedDbBodyShelf', () => {
  it('keeps bodies across a new shelf on the same database, as across a reload', async () => {
    const factory = new IDBFactory();
    const kept = await new IndexedDbBodyShelf(factory).add(described, new Uint8Array([4, 5, 6]));
    const again = new IndexedDbBodyShelf(factory);
    expect((await again.list()).map((body) => body.id)).toEqual([kept.id]);
    expect([...(await again.read(kept.id))]).toEqual([4, 5, 6]);
  });
});

describe('bodyFor (P7-T02, ADR-59)', () => {
  const shelf = new InMemoryBodyShelf();
  const mine = { ...described, id: 'own:1', addedAt: '2026-10-14T00:00:00.000Z' };

  it("wears the pack's default with nothing chosen, or a choice no longer there", () => {
    expect(bodyFor(null, PLACEHOLDER_BODY_ID, shelf, []).id).toBe(PLACEHOLDER_BODY_ID);
    expect(bodyFor('gone', PLACEHOLDER_BODY_ID, shelf, []).id).toBe(PLACEHOLDER_BODY_ID);
    expect(bodyFor('own:2', PLACEHOLDER_BODY_ID, shelf, [mine]).id).toBe(PLACEHOLDER_BODY_ID);
  });

  it('wears a built-in body as a download behind consent, and an own one from the shelf', () => {
    expect(bodyFor(PLACEHOLDER_BODY_ID, PLACEHOLDER_BODY_ID, shelf, [])).toMatchObject({ kind: 'download', id: PLACEHOLDER_BODY_ID });
    // The generated Alice was a built-in body until 2026-10-16; a choice of her is the default now.
    expect(bodyFor('alice-generated', PLACEHOLDER_BODY_ID, shelf, [])).toMatchObject({ kind: 'download', id: PLACEHOLDER_BODY_ID });
    expect(bodyFor('own:1', PLACEHOLDER_BODY_ID, shelf, [mine])).toMatchObject({ kind: 'local', id: 'own:1', name: 'Mine' });
  });

  it('takes an own body on trust while the shelf is still being read', () => {
    expect(bodyFor('own:2', PLACEHOLDER_BODY_ID, shelf, null)).toMatchObject({ kind: 'local', id: 'own:2' });
  });

  it('gives every built-in body its own consent entry and exact size', () => {
    expect(new Set(BUILT_IN_BODIES.map((body) => body.descriptor.id)).size).toBe(BUILT_IN_BODIES.length);
    for (const body of BUILT_IN_BODIES) expect(body.descriptor.sizeBytes).toBe(body.asset.bytes);
  });
});
