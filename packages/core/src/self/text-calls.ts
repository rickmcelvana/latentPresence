import type { JsonObject, JsonValue } from '@latentpresence/protocol';

/**
 * Tool calls a model wrote as text (R-29): Gemma 4 31b, offered real tools, wrote one in about
 * 1 ask in 6 as `[tool:files__read_text_file(path="…")]`, `<call:files__read_text_file
 * path="…"/>` or its own native syntax, `[tool_call:files__read_text_file{path:<|"|>…<|"|>}]`
 * (`<|"|>` is Gemma's string quote) — nothing ran, the person heard the markup, and once it went on to say what the
 * file held. The loop holds such text back as it streams and runs it as the call it meant;
 * whatever followed it, a result it imagined, is never said.
 */

/** How a written call starts. Anything else in brackets streams on as it always did. */
const MARKERS = ['[tool:', '[tool_call:', '<call:', '<tool_call>', '<|tool_call>'] as const;

/** A call as written: the tool's name and the arguments it gave. */
export interface WrittenCall {
  readonly name: string;
  readonly arguments: JsonObject;
}

/**
 * Streams text through, holding back from the first written-call marker on (and a tail that
 * could still become one). `feed` returns what may be said now; `end` returns the rest of what
 * may be said and the calls held back.
 */
export class TextCallScanner {
  private held = '';
  private marked = false;

  feed(text: string): string {
    if (this.marked) {
      this.held += text;
      return '';
    }
    const buffer = this.held + text;
    const at = firstMarker(buffer);
    if (at !== -1) {
      this.marked = true;
      this.held = buffer.slice(at);
      return buffer.slice(0, at);
    }
    // Keep a tail that could be the start of a marker ("[to", "<"), until the next delta says.
    const keep = partialTail(buffer);
    this.held = buffer.slice(buffer.length - keep);
    return buffer.slice(0, buffer.length - keep);
  }

  end(): { readonly text: string; readonly calls: readonly WrittenCall[] } {
    if (!this.marked) {
      const text = this.held;
      this.held = '';
      return { text, calls: [] };
    }
    const calls = parseWrittenCalls(this.held);
    this.held = '';
    this.marked = false;
    return { text: '', calls };
  }
}

function firstMarker(text: string): number {
  const lower = text.toLowerCase();
  let first = -1;
  for (const marker of MARKERS) {
    const at = lower.indexOf(marker);
    if (at !== -1 && (first === -1 || at < first)) first = at;
  }
  return first;
}

/** The length of the longest end of `text` that is the start of a marker. */
function partialTail(text: string): number {
  const lower = text.toLowerCase();
  for (let length = Math.min(lower.length, 13); length > 0; length -= 1) {
    const tail = lower.slice(lower.length - length);
    if (MARKERS.some((marker) => marker.startsWith(tail) && tail.length < marker.length)) return length;
  }
  return 0;
}

function value(raw: string): JsonValue {
  if (raw.startsWith('"')) {
    // `"C:\notes\temp"` is valid JSON — with a newline and a tab in it. A drive and one
    // backslash is a path written as it is, not an escape.
    if (/^"[A-Za-z]:\\(?!\\)/u.test(raw)) return raw.slice(1, -1);
    try {
      return JSON.parse(raw) as JsonValue;
    } catch {
      // A Windows path with single backslashes is not JSON: the text between the quotes.
      return raw.slice(1, -1);
    }
  }
  if (raw.startsWith("'")) return raw.slice(1, -1);
  try {
    return JSON.parse(raw) as JsonValue;
  } catch {
    return raw;
  }
}

/** `key="value", other=3` or `key: "value"` or a JSON object, as arguments. */
function parseArguments(text: string): JsonObject {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as JsonObject;
    } catch {
      // Not JSON after all: read it as pairs.
    }
  }
  const args: Record<string, JsonValue> = {};
  for (const match of trimmed.matchAll(/([A-Za-z_][\w-]*)\s*[=:]\s*("(?:[^"\\]|\\.)*"|'[^']*'|[^\s,)/>\]]+)/gu)) {
    const [, key, raw] = match;
    if (key !== undefined && raw !== undefined) args[key] = value(raw);
  }
  return args;
}

/** Every call written in `text`, in order. A marker with no name it can read is no call. */
export function parseWrittenCalls(written: string): WrittenCall[] {
  const text = written.replaceAll('<|"|>', '"');
  const calls: WrittenCall[] = [];
  // `<tool_call>{"name": …, "arguments": {…}}</tool_call>`, the shape some templates use.
  for (const match of text.matchAll(/<\|?tool_call\|?>\s*(\{[\s\S]*?\})\s*<\/?\|?tool_call\|?>/gu)) {
    try {
      const parsed = JSON.parse(match[1] ?? '') as { name?: unknown; arguments?: unknown; parameters?: unknown };
      const args = parsed.arguments ?? parsed.parameters ?? {};
      if (typeof parsed.name === 'string' && args !== null && typeof args === 'object' && !Array.isArray(args)) {
        calls.push({ name: parsed.name, arguments: args as JsonObject });
      }
    } catch {
      // Unreadable: not a call.
    }
  }
  // `[tool:name(key="value")]`, `[tool_call:name{key:"value"}]`, `<|tool_call>call:name{…}<tool_call|>`
  // and `<call:name key="value"/>` (or `<call:name>…</call>`).
  const shapes =
    /\[tool(?:_call)?:\s*(?:call:)?([\w-]+)\s*(?:\(([\s\S]*?)\)|\{([\s\S]*?)\})?\s*\]|<\|tool_call>\s*call:([\w-]+)\s*\{([\s\S]*?)\}\s*<tool_call\|>|<call:\s*([\w-]+)([\s\S]*?)\/?>/gu;
  for (const match of text.matchAll(shapes)) {
    const name = match[1] ?? match[4] ?? match[6];
    if (name !== undefined) calls.push({ name, arguments: parseArguments(match[2] ?? match[3] ?? match[5] ?? match[7] ?? '') });
  }
  return calls;
}
