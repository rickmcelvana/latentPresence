import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import type { ModelConsent } from '@latentpresence/ml-web/consent';
import { MODEL_CACHE_NAME } from '@latentpresence/ml-web/consent';
import { formatMb } from '../consent/format';
import type { MinimalCache, MinimalCacheStorage } from '../consent/deps';

/**
 * "Downloaded models" (P1-T13, task 4): what is actually on disk, read from the caches
 * themselves rather than from `consent.granted()` — an id can be granted with nothing
 * fetched yet (the user agreed, then closed the tab before the download finished), and a
 * screen answering "what is on this computer" from the wrong source would say so wrongly.
 *
 * Two caches, both named in `docs/SURFACE.md`'s "What actually downloads weights":
 * `transformers-cache` (`@huggingface/transformers`'s own name, not exported by the
 * library, so it is written down here) for Kokoro, Moonshine and Whisper, and
 * `latentpresence-models` (`MODEL_CACHE_NAME`, `packages/ml-web/src/consent/model-cache.ts`)
 * for Silero and Smart Turn, which now fetch their own bytes instead of handing ort a URL.
 */

const TRANSFORMERS_CACHE_NAME = 'transformers-cache';

const KNOWN_CACHES: readonly { readonly name: string; readonly note: string }[] = [
  { name: TRANSFORMERS_CACHE_NAME, note: 'Kokoro, Moonshine and Whisper' },
  { name: MODEL_CACHE_NAME, note: 'Silero VAD and Smart Turn' },
];

interface CacheRow {
  readonly name: string;
  readonly note: string;
  readonly entries: number;
  readonly bytes: number;
}

/** A response's size: `content-length` when the cache kept one (a real network response
 * does), else the body itself — slower, but correct regardless of how an entry was put. */
async function entryBytes(cache: MinimalCache, request: Request): Promise<number> {
  try {
    const response = await cache.match(request);
    if (response === undefined) return 0;
    const header = response.headers.get('content-length');
    const declared = header === null ? Number.NaN : Number(header);
    if (Number.isFinite(declared)) return declared;
    return (await response.clone().blob()).size;
  } catch {
    return 0;
  }
}

async function summarize(caches: MinimalCacheStorage, name: string, note: string): Promise<CacheRow | null> {
  try {
    const names = await caches.keys();
    if (!names.includes(name)) return null;
    const cache = await caches.open(name);
    const requests = await cache.keys();
    let bytes = 0;
    for (const request of requests) bytes += await entryBytes(cache, request);
    return { name, note, entries: requests.length, bytes };
  } catch {
    // A cache that cannot be read is reported as absent rather than crashing the section —
    // the same private-window degradation `model-cache.ts` and `ModelConsent` both make.
    return null;
  }
}

/** Every known cache that is actually present, summarised. No React in this function, so
 * both the mount effect and the delete handlers below can call it without either owning
 * the other's loading logic. */
async function loadRows(caches: MinimalCacheStorage): Promise<readonly CacheRow[]> {
  const summaries = await Promise.all(KNOWN_CACHES.map(({ name, note }) => summarize(caches, name, note)));
  return summaries.filter((row): row is CacheRow => row !== null);
}

export interface DownloadedModelsSectionProps {
  readonly caches: MinimalCacheStorage;
  readonly consent: ModelConsent;
}

export function DownloadedModelsSection({ caches, consent }: DownloadedModelsSectionProps): ReactElement {
  const [rows, setRows] = useState<readonly CacheRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  // A mount-time read of an external system (Cache Storage), guarded against setting state
  // after the section has unmounted — `caches.keys()` on a slow disk can still be pending
  // when a user leaves `/settings`.
  useEffect(() => {
    let cancelled = false;
    void loadRows(caches).then((loadedRows) => {
      if (cancelled) return;
      setRows(loadedRows);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [caches]);

  async function deleteOne(name: string): Promise<void> {
    setBusy(true);
    try {
      await caches.delete(name);
      setRows(await loadRows(caches));
    } finally {
      setBusy(false);
    }
  }

  async function deleteAll(): Promise<void> {
    setBusy(true);
    try {
      for (const { name } of KNOWN_CACHES) await caches.delete(name);
      // Only "delete all" revokes: deleting one cache still leaves the other model's
      // weights on disk, so what was agreed to is still true for those.
      consent.revoke();
      setRows(await loadRows(caches));
    } finally {
      setBusy(false);
    }
  }

  const total = rows.reduce((sum, row) => sum + row.bytes, 0);

  return (
    <section className="panel settings-section">
      <div className="panel-header">
        <span className="panel-title">Downloaded models</span>
        {rows.length > 0 && <span className="pill pill-accent">{formatMb(total)} total</span>}
      </div>
      <p className="field-hint">
        What is actually on this computer, read from its storage rather than from what you agreed to. Deleting one
        means the next use downloads it again.
      </p>
      {!loaded ? (
        <p className="settings-cache-empty">Checking…</p>
      ) : rows.length === 0 ? (
        <p className="settings-cache-empty">Nothing downloaded yet.</p>
      ) : (
        <ul className="settings-cache-list">
          {rows.map((row) => (
            <li className="settings-cache-row" key={row.name}>
              <div className="settings-cache-info">
                <span className="settings-cache-name">{row.name}</span>
                <span className="settings-cache-meta">
                  {row.note} · {row.entries} file{row.entries === 1 ? '' : 's'} · {formatMb(row.bytes)}
                </span>
              </div>
              <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => void deleteOne(row.name)} type="button">
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
      {rows.length > 0 && (
        <div className="settings-cache-actions">
          <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => void deleteAll()} type="button">
            Delete all
          </button>
        </div>
      )}
    </section>
  );
}
