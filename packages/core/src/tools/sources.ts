import type { JsonValue } from '@latentpresence/protocol';

/**
 * The sources an outside tool's result gave her to cite (P5-T06, ADR-47): the companion's web
 * server answers a search with `found: [{ ref, title, url, site, snippet }]` and a page with
 * `{ ref, title, url, site, text }`, each `ref` citable as `[cite:<ref>]` (ADR-45). The page keeps
 * them beside her documents' hits, so a web source is listed under her answer the same way.
 */
export interface CitedSource {
  readonly ref: string;
  readonly title: string;
  /** Where in it: the site, for a web page. */
  readonly locator: string | null;
  /** Its address. */
  readonly source: string;
  /** What she was given of it. */
  readonly text: string;
}

/** What a source shows when opened: enough to check her against, not the page. */
const SHOWN_CHARS = 600;

type JsonRecord = { readonly [key: string]: JsonValue };

function record(value: JsonValue | undefined): JsonRecord | null {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function text(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : '';
}

function source(entry: JsonRecord, body: string): CitedSource | null {
  const ref = text(entry['ref']);
  const url = text(entry['url']);
  if (!/^w[0-9a-f]{6}$/u.test(ref) || !/^https?:\/\//u.test(url)) return null;
  const site = text(entry['site']);
  return {
    ref,
    title: text(entry['title']) || url,
    locator: site === '' ? null : site,
    source: url,
    text: body.length > SHOWN_CHARS ? `${body.slice(0, SHOWN_CHARS)}…` : body,
  };
}

/**
 * Every citable source in a tool's result, as `mcpTools` returns it (`{ from, result }`, or the
 * structured result itself). Anything else — an error, a result with no refs — gives none.
 */
export function citedSources(value: JsonValue): CitedSource[] {
  const outer = record(value);
  if (outer === null) return [];
  const result = record(outer['result']) ?? outer;
  const found = result['found'];
  if (Array.isArray(found)) {
    return found.flatMap((entry) => {
      const hit = record(entry);
      const cited = hit === null ? null : source(hit, text(hit['snippet']));
      return cited === null ? [] : [cited];
    });
  }
  const page = source(result, text(result['text']));
  return page === null ? [] : [page];
}
