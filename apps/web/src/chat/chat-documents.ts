import { citationRef, documentSearchTool, type LocalTool } from '@latentpresence/core';
import { companionIngest, type CompanionIngest, type HttpFetch } from '@latentpresence/providers/web';
import type { CitationSource } from '../transcript/TranscriptPanel';

/**
 * The page's side of her documents (P5-T04, ADR-45): when Settings → Documents turned searching
 * on, ask the companion once whether it has any, and if so give her `documents_search` — keeping
 * every hit she is given, so the transcript can show the sources she cites.
 */

export interface ConnectedDocuments {
  /** Her tool, or null: searching is off, the companion is not answering, or it has nothing. */
  readonly tool: LocalTool | null;
  /** The hits she was given this visit, by the ref she cites them with. */
  readonly sources: ReadonlyMap<string, CitationSource>;
  /** Something the person should hear: they turned searching on and it cannot work. */
  readonly notice: string | null;
}

export interface ConnectDocumentsOptions {
  readonly companionUrl: string;
  readonly fetch?: HttpFetch | undefined;
  /** Test seam: the companion's client. */
  readonly ingest?: CompanionIngest | undefined;
}

/** Never throws: a companion that is not answering is a notice, not a broken page. */
export async function connectDocuments(options: ConnectDocumentsOptions): Promise<ConnectedDocuments> {
  const ingest = options.ingest ?? companionIngest({ baseUrl: options.companionUrl, ...(options.fetch === undefined ? {} : { fetch: options.fetch }) });
  const sources = new Map<string, CitationSource>();
  let documents: number;
  try {
    const status = await ingest.status();
    documents = status.folders.reduce((sum, folder) => sum + folder.documents, 0);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { tool: null, sources, notice: `searching your documents is on, and ${why}; start it with "pnpm companion", then reload this page.` };
  }
  if (documents === 0) {
    return { tool: null, sources, notice: 'searching your documents is on, and the companion has none indexed yet: list a folder in its documents.json, then reload.' };
  }
  const tool = documentSearchTool((query, limit) => ingest.search(query, limit), {
    onFound: (hits) => {
      for (const hit of hits) sources.set(citationRef(hit), { title: hit.title, locator: hit.locator, source: hit.source, text: hit.text });
    },
  });
  return { tool, sources, notice: null };
}
