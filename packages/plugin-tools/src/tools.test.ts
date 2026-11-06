import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diskFolder, sha256Hex } from './folder';
import { pinAssets } from './pin';

describe('diskFolder (P10-T01)', () => {
  const root = mkdtempSync(join(tmpdir(), 'lp-plugin-'));
  mkdirSync(join(root, 'plugin', 'data'), { recursive: true });
  writeFileSync(join(root, 'plugin', 'data', 'a.json'), '[{"id":"a"}]');
  writeFileSync(join(root, 'secret.txt'), 'not yours');
  const folder = diskFolder(join(root, 'plugin'));

  it('reads files inside the folder, and null for what is not there', async () => {
    expect(await folder.text('data/a.json')).toBe('[{"id":"a"}]');
    expect(await folder.text('data/missing.json')).toBeNull();
    expect(await folder.text('data')).toBeNull();
  });

  it('never reads outside it, whatever the path says', async () => {
    for (const path of ['../secret.txt', 'data/../../secret.txt', join(root, 'secret.txt'), '']) expect(await folder.text(path), path).toBeNull();
  });

  it('hashes with SHA-256', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('pinAssets (P10-T01)', () => {
  it('writes each asset\'s size and hash from its file or address, and says which it could not read', async () => {
    const files: Record<string, Uint8Array> = { 'img/a.png': new Uint8Array([1, 2, 3]) };
    const raw = {
      format: 1,
      assets: [
        { id: 'a', path: 'img/a.png', bytes: 1, sha256: '0' },
        { id: 'b', url: 'https://example.com/b.jpg' },
        { id: 'c', url: 'https://example.com/gone.jpg' },
        { id: 'd', path: 'img/none.png' },
      ],
    };
    const folder = { bytes: async (path: string) => files[path] ?? null, text: async () => null };
    const fetched: string[] = [];
    const result = await pinAssets(raw, folder, sha256Hex, async (url) => {
      fetched.push(url);
      if (url.endsWith('gone.jpg')) throw new Error('HTTP 404');
      return new Uint8Array([4, 5]);
    });
    expect(result.pinned).toBe(2);
    expect(result.failed.toSorted()).toEqual(['Asset "c": HTTP 404', 'Asset "d": no file and no address to read']);
    expect(raw.assets[0]).toEqual({ id: 'a', path: 'img/a.png', bytes: 3, sha256: await sha256Hex(new Uint8Array([1, 2, 3])) });
    expect(raw.assets[1]).toEqual({ id: 'b', url: 'https://example.com/b.jpg', bytes: 2, sha256: await sha256Hex(new Uint8Array([4, 5])) });
    expect(fetched.toSorted()).toEqual(['https://example.com/b.jpg', 'https://example.com/gone.jpg']);
  });
});
