import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MODEL_CACHE_NAME, ModelConsent } from '@latentpresence/ml-web/consent';
import type { MinimalCache, MinimalCacheStorage } from '../consent/deps';
import { DownloadedModelsSection } from './DownloadedModelsSection';

afterEach(cleanup);

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  const backing = new Map<string, string>();
  return {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => {
      backing.set(key, value);
    },
    removeItem: (key: string) => {
      backing.delete(key);
    },
  };
}

/** An in-memory Cache Storage, since jsdom implements none at all. */
function fakeCaches(entries: Record<string, readonly { url: string; bytes: number }[]>): MinimalCacheStorage {
  const names = Object.keys(entries);
  const caches: Record<string, MinimalCache> = {};
  for (const [name, files] of Object.entries(entries)) {
    caches[name] = {
      keys: async () => files.map((file) => new Request(file.url)),
      match: async (request) => {
        const url = typeof request === 'string' ? request : request.url;
        const file = files.find((entry) => entry.url === url);
        // A typed array body, not a `Blob`: jsdom's `Blob` has no `.stream()`, which the
        // `Response` implementation this environment's `fetch` brings in requires.
        return file === undefined ? undefined : new Response(new Uint8Array(file.bytes), { headers: { 'content-length': String(file.bytes) } });
      },
    };
  }
  const remaining = new Set(names);
  return {
    keys: async () => [...remaining],
    open: async (name: string) => {
      const cache = caches[name];
      if (cache === undefined) throw new Error(`no such cache: ${name}`);
      return cache;
    },
    delete: async (name: string) => remaining.delete(name),
  };
}

describe('DownloadedModelsSection', () => {
  it('says nothing downloaded yet when both caches are empty', async () => {
    render(<DownloadedModelsSection caches={fakeCaches({})} consent={new ModelConsent(memoryStorage())} />);
    await waitFor(() => expect(screen.getByText('Nothing downloaded yet.')).toBeTruthy());
  });

  it('lists what is cached, with sizes, reading the cache rather than what was agreed to', async () => {
    const caches = fakeCaches({
      'transformers-cache': [
        { url: 'https://huggingface.co/x/model.onnx', bytes: 2_000_000 },
        { url: 'https://huggingface.co/x/config.json', bytes: 500_000 },
      ],
    });
    // Nothing granted at all — the section still shows what is on disk.
    render(<DownloadedModelsSection caches={caches} consent={new ModelConsent(memoryStorage())} />);
    await waitFor(() => expect(screen.getByText('transformers-cache')).toBeTruthy());
    expect(screen.getByText(/2\.5 MB total/)).toBeTruthy();
    expect(screen.getByText(/2 files/)).toBeTruthy();
  });

  it('Delete removes just that cache, leaving the other and consent alone', async () => {
    const caches = fakeCaches({
      [MODEL_CACHE_NAME]: [{ url: 'https://huggingface.co/silero/model.onnx', bytes: 2_243_022 }],
      'transformers-cache': [{ url: 'https://huggingface.co/kokoro/model.onnx', bytes: 92_361_116 }],
    });
    const consent = new ModelConsent(memoryStorage());
    consent.grant([{ id: 'x', label: 'x', sizeBytes: 1, licence: 'MIT', sourceUrl: 'https://example.com' }]);
    render(<DownloadedModelsSection caches={caches} consent={consent} />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(2));

    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0] as HTMLButtonElement);

    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(1));
    expect(consent.granted()).toEqual(['x']);
  });

  it('Delete all removes both caches and revokes consent', async () => {
    const caches = fakeCaches({
      [MODEL_CACHE_NAME]: [{ url: 'https://huggingface.co/silero/model.onnx', bytes: 2_243_022 }],
      'transformers-cache': [{ url: 'https://huggingface.co/kokoro/model.onnx', bytes: 92_361_116 }],
    });
    const consent = new ModelConsent(memoryStorage());
    consent.grant([{ id: 'x', label: 'x', sizeBytes: 1, licence: 'MIT', sourceUrl: 'https://example.com' }]);
    render(<DownloadedModelsSection caches={caches} consent={consent} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete all' })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Delete all' }));

    await waitFor(() => expect(screen.getByText('Nothing downloaded yet.')).toBeTruthy());
    expect(consent.granted()).toEqual([]);
  });

  it('says plainly that deleting means downloading again', async () => {
    render(<DownloadedModelsSection caches={fakeCaches({})} consent={new ModelConsent(memoryStorage())} />);
    expect(screen.getByText(/the next use downloads it again/)).toBeTruthy();
  });
});
