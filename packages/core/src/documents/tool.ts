import type { DocumentHit, DocumentSearchResponse, JsonValue } from '@latentpresence/protocol';
import type { LocalTool } from '../self/tools';

/**
 * `documents_search` (P5-T04, ADR-45): one of her own tools, like her notes — it reads only what
 * the person put in the companion's folders, so it is not gated, but the page shows that she
 * looked. Each hit reaches the model with a `ref` (`c` and the chunk id) to cite it by, so she
 * copies an id rather than inventing one.
 */

export type DocumentSearch = (query: string, limit: number) => Promise<DocumentSearchResponse>;

/** The ref she cites a chunk by: `[cite:c6612]`. */
export function citationRef(hit: Pick<DocumentHit, 'chunkId'>): string {
  return `c${hit.chunkId}`;
}

/** How much of a chunk she reads: the whole of one, which ingestion keeps near 1,000. */
const TEXT_LIMIT = 1500;
const DEFAULT_LIMIT = 5;

export interface DocumentSearchToolOptions {
  /** Every hit she was given, so the page can show the sources she cites. */
  readonly onFound?: (hits: readonly DocumentHit[]) => void;
}

export function documentSearchTool(search: DocumentSearch, options: DocumentSearchToolOptions = {}): LocalTool {
  return {
    definition: {
      name: 'documents_search',
      description: "Search the person's own documents (manuals, notes, papers) for passages about something. Returns passages with a ref to cite each by.",
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to look for, in a few words: the thing, not a question.' },
          limit: { type: 'integer', minimum: 1, maximum: 10, description: 'How many passages, 5 if unsure.' },
        },
        required: ['query'],
      },
    },
    async run(args): Promise<JsonValue> {
      const query = typeof args['query'] === 'string' ? args['query'].trim().slice(0, 1000) : '';
      if (query === '') return { error: 'Say what to look for.' };
      const asked = typeof args['limit'] === 'number' ? Math.round(args['limit']) : DEFAULT_LIMIT;
      const limit = Math.min(10, Math.max(1, Number.isFinite(asked) ? asked : DEFAULT_LIMIT));
      let found: DocumentSearchResponse;
      try {
        found = await search(query, limit);
      } catch (error) {
        return { error: `Their documents could not be searched: ${error instanceof Error ? error.message : String(error)}` };
      }
      options.onFound?.(found.hits);
      if (found.hits.length === 0) return { found: [], note: 'Nothing in their documents matches. Say so; do not make up an answer from them.' };
      return {
        // Said where she reads the passages, not only in the prompt: glm-5.2 answered right and
        // left the tag off once in fifteen when the rule was only in the prompt (P5-T04).
        cite: 'End each sentence that uses a passage with its ref as a tag, like [cite:c123]. Do not say the ref aloud.',
        found: found.hits.map((hit) => ({
          ref: citationRef(hit),
          document: hit.title,
          where: hit.locator,
          text: hit.text.length > TEXT_LIMIT ? `${hit.text.slice(0, TEXT_LIMIT)}…` : hit.text,
        })),
      };
    },
  };
}
