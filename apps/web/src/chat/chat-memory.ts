import { HealthResponseSchema, type MemoryStore } from '@latentpresence/protocol';
import { CompanionMemoryStore, IndexedDbMemoryStore, normaliseBaseUrl, type HttpFetch } from '@latentpresence/providers/web';
import type { MemorySetting } from '../settings/settings';

/**
 * Which store `/chat` remembers in (P4-T04b, ADR-38). Pure apart from the `fetch` and
 * `indexedDB` it is handed, so a test decides both.
 *
 * `auto` asks the companion's `/health` once, with a short timeout: a companion that answers
 * with a connected database is where memory goes (MariaDB, shared by every browser the person
 * uses); anything else — no companion, no database, a slow answer — is this browser's own
 * IndexedDB. The choice is made once per visit and said in `reason`, so the page can show it.
 */
export interface MemoryChoice {
  readonly store: MemoryStore;
  readonly kind: 'companion' | 'browser';
  readonly reason: string;
  /**
   * Something the person must hear: memory is set to the companion and it is not answering, so
   * nothing is remembered and no plan or note can be saved until it is (R-27, 2026-10-09 — that
   * failed silently). The store is still the companion's: it works the moment the companion does.
   */
  readonly warning?: string | undefined;
}

export interface ChooseMemoryOptions {
  readonly setting: MemorySetting;
  readonly companionUrl: string;
  readonly fetch: HttpFetch;
  /** `globalThis.indexedDB`, or undefined where there is none (then browser memory is off). */
  readonly indexedDB: IDBFactory | undefined;
  readonly timeoutMs?: number;
}

export const HEALTH_TIMEOUT_MS = 1500;

async function companionHasDatabase(companionUrl: string, fetch: HttpFetch, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${normaliseBaseUrl(companionUrl)}/health`, { signal: controller.signal });
    if (!response.ok) return false;
    const health = HealthResponseSchema.safeParse(await response.json());
    return health.success && health.data.database.connected;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function chooseMemoryStore(options: ChooseMemoryOptions): Promise<MemoryChoice | null> {
  const { setting, companionUrl, fetch } = options;
  if (setting === 'off') return null;
  const companion = (): MemoryChoice => ({ store: new CompanionMemoryStore({ baseUrl: companionUrl, fetch }), kind: 'companion', reason: `the companion at ${companionUrl}` });
  const browser = (why: string): MemoryChoice | null =>
    options.indexedDB === undefined ? null : { store: new IndexedDbMemoryStore({ indexedDB: options.indexedDB }), kind: 'browser', reason: why };
  if (setting === 'companion') {
    // Asked only to warn: the person chose the companion, so its store is used either way.
    if (await companionHasDatabase(companionUrl, fetch, options.timeoutMs ?? HEALTH_TIMEOUT_MS)) return companion();
    return {
      ...companion(),
      warning: `memory is set to the companion at ${companionUrl}, and it is not answering (or has no database). Nothing from this visit is remembered, and she cannot save plans or notes, until it runs: start it with "pnpm companion", then reload this page.`,
    };
  }
  if (setting === 'browser') return browser('this browser');
  return (await companionHasDatabase(companionUrl, fetch, options.timeoutMs ?? HEALTH_TIMEOUT_MS))
    ? companion()
    : browser('this browser (no companion with a database answered)');
}
