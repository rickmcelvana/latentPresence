import { CompanionErrorSchema, companionRoutes, type CancellationSignal, type DocumentSearchResponse, type IngestJob, type IngestStatus } from '@latentpresence/protocol';
import type { HttpFetch } from '../llm/discovery';
import { normaliseBaseUrl } from '../llm/discovery';

/**
 * The companion's document ingestion as the page sees it (P5-T03, ADR-44). **The page never
 * names a path**: the companion indexes the folders in its own `documents.json`. The page can
 * read how that is going, ask for a scan now, and follow a job — nothing else.
 */
export interface CompanionIngestOptions {
  /** The companion's origin — settings' `companionUrl`. */
  readonly baseUrl: string;
  readonly fetch?: HttpFetch | undefined;
  readonly signal?: CancellationSignal | undefined;
}

export interface CompanionIngest {
  /** The folders, the embedding model, whether it is watching, and the running or last job. */
  status(): Promise<IngestStatus>;
  /** Scan every folder now: the running job if one is running, else a new one. */
  scan(): Promise<IngestJob>;
  job(id: string): Promise<IngestJob>;
  /** Her search of the documents (P5-T04, ADR-45): the companion embeds the query and fuses. */
  search(query: string, limit: number): Promise<DocumentSearchResponse>;
}

function abortSignal(signal: CancellationSignal | undefined): { signal?: AbortSignal } {
  if (signal === undefined) return {};
  if (signal instanceof AbortSignal) return { signal };
  const controller = new AbortController();
  if (signal.aborted) controller.abort();
  else signal.addEventListener('abort', () => controller.abort());
  return { signal: controller.signal };
}

const OTHER_VERSION = 'the companion answered in a shape this page does not know — it may be a different version';

export function companionIngest(options: CompanionIngestOptions): CompanionIngest {
  const baseUrl = normaliseBaseUrl(options.baseUrl);
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);

  async function call<T>(route: { readonly method: string; readonly response: { safeParse(value: unknown): { success: true; data: T } | { success: false } } }, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      const sent = body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
      response = await fetchImpl(`${baseUrl}${path}`, { method: route.method, ...sent, ...abortSignal(options.signal) });
    } catch (error) {
      throw new Error(`the companion is not answering (${error instanceof Error ? error.message : String(error)})`, { cause: error });
    }
    const json: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const failure = CompanionErrorSchema.safeParse(json);
      throw new Error(failure.success ? failure.data.error.message : `the companion answered ${response.status}`);
    }
    const parsed = route.response.safeParse(json);
    if (!parsed.success) throw new Error(OTHER_VERSION);
    return parsed.data;
  }

  return {
    status: () => call(companionRoutes.ingestStatus, companionRoutes.ingestStatus.path),
    scan: () => call(companionRoutes.ingestScan, companionRoutes.ingestScan.path),
    job: (id) => call(companionRoutes.ingestJob, companionRoutes.ingestJob.path.replace(':id', encodeURIComponent(id))),
    search: (query, limit) => call(companionRoutes.documentsSearch, companionRoutes.documentsSearch.path, { query, limit }),
  };
}
