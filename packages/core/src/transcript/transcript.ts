import type { ConversationEvent } from '@latentpresence/protocol';

/** The `error` event's `scope` field. Not exported by `@latentpresence/protocol` on its
 * own, so it is pulled out of the discriminated union rather than duplicated by hand. */
type ErrorScope = Extract<ConversationEvent, { type: 'error' }>['scope'];

/**
 * The transcript reducer (P1-T11, `docs/ui/transcript.md`).
 *
 * A record of what was **said**, spoken or typed, and nothing else: never a line for a
 * word that was later taken back (ADR-25), never a line for a reply nobody heard any of,
 * never a line for a backchannel (ADR-28) or the model's reasoning. `reduceTranscript` is
 * the only place these rules live — pure, no DOM, so the panel, `/dev/voice`'s harness and
 * Phase 2's call screen all read the same `state.lines`, and memory (P4) can reuse it.
 */

export type TranscriptLine =
  | { readonly kind: 'user'; readonly id: string; readonly text: string; readonly at: string; readonly via: 'voice' | 'text' }
  | {
      readonly kind: 'assistant';
      readonly id: string;
      readonly at: string;
      readonly status: 'streaming' | 'complete' | 'interrupted';
      /** Streaming: the raw tokens so far. Settled: the entry's tag-free text. */
      readonly text: string;
      /** Interrupted: what was heard (the entry's `spokenPrefix`). Otherwise null. */
      readonly heard: string | null;
      /** Interrupted: the part of `text` after `heard` — generated, never said. May be ''. */
      readonly unsaid: string;
      readonly firstTokenMs: number | null;
      readonly firstAudioMs: number | null;
    }
  | { readonly kind: 'notice'; readonly id: string; readonly at: string; readonly text: string };

/**
 * `lines` is the only field a caller should read. The rest is bookkeeping the reducer
 * needs across events: the start of the current turn (for latency), which line — if any
 * — is still open (streaming, or interrupted but not yet settled), whether that line's
 * first audio has already been marked (it may get more than one `audio.started`, one per
 * sentence, and only the first counts), and a counter for ids the reducer mints itself.
 */
export interface TranscriptState {
  readonly lines: readonly TranscriptLine[];
  readonly turnStartAt: number | null;
  readonly openIndex: number | null;
  readonly audioMarked: boolean;
  readonly nextId: number;
}

export function emptyTranscript(): TranscriptState {
  return { lines: [], turnStartAt: null, openIndex: null, audioMarked: false, nextId: 1 };
}

/** A notice's wording by error scope, per the note: "The language model failed: …", "The
 * voice failed: …", "and so on by scope." Voice = speech synthesis (`VoiceSection` in
 * settings), hearing = speech recognition (`HearingSection`) — the same split the
 * settings page already draws. */
const SCOPE_LABEL: Record<ErrorScope, string> = {
  llm: 'The language model',
  tts: 'The voice',
  stt: 'The hearing',
  memory: 'Memory',
  tool: 'A tool',
  avatar: 'The avatar',
  companion: 'The companion',
};

const NOTHING_RECOGNISED = 'nothing was recognised';

function atMs(at: string): number {
  return new Date(at).getTime();
}

function withLines(state: TranscriptState, lines: readonly TranscriptLine[]): TranscriptState {
  return { ...state, lines };
}

/** Append a line, closing out any open bookkeeping the caller has already resolved. */
function appended(state: TranscriptState, line: TranscriptLine): TranscriptState {
  return withLines(state, [...state.lines, line]);
}

function replaceAt(lines: readonly TranscriptLine[], index: number, line: TranscriptLine): TranscriptLine[] {
  const next = lines.slice();
  next[index] = line;
  return next;
}

function removeAt(lines: readonly TranscriptLine[], index: number): TranscriptLine[] {
  const next = lines.slice();
  next.splice(index, 1);
  return next;
}

/** The open assistant line — streaming, or interrupted but not yet settled — or null. */
function openLine(state: TranscriptState): { readonly index: number; readonly line: Extract<TranscriptLine, { kind: 'assistant' }> } | null {
  if (state.openIndex === null) return null;
  const line = state.lines[state.openIndex];
  if (line === undefined || line.kind !== 'assistant') return null;
  return { index: state.openIndex, line };
}

/**
 * Apply one `ConversationEvent` to a transcript. Pure: always returns a new state (or the
 * same one, functionally unchanged) and never mutates `state`.
 */
export function reduceTranscript(state: TranscriptState, event: ConversationEvent): TranscriptState {
  switch (event.type) {
    case 'user.turn.ended':
      return { ...state, turnStartAt: atMs(event.at) };

    case 'user.turn.resumed':
      return { ...state, turnStartAt: null };

    case 'user.transcript': {
      if (!event.isFinal) return state;
      const line: TranscriptLine = { kind: 'user', id: `t-${state.nextId}`, text: event.text, at: event.at, via: 'voice' };
      return appended({ ...state, nextId: state.nextId + 1 }, line);
    }

    case 'user.message': {
      const line: TranscriptLine = { kind: 'user', id: `t-${state.nextId}`, text: event.text, at: event.at, via: 'text' };
      return appended({ ...state, nextId: state.nextId + 1, turnStartAt: atMs(event.at) }, line);
    }

    case 'assistant.token': {
      const open = openLine(state);
      if (open !== null && open.line.status === 'streaming') {
        const line = { ...open.line, text: open.line.text + event.text };
        return withLines(state, replaceAt(state.lines, open.index, line));
      }
      const firstTokenMs = state.turnStartAt === null ? null : atMs(event.at) - state.turnStartAt;
      const line: TranscriptLine = {
        kind: 'assistant',
        id: `t-${state.nextId}`,
        at: event.at,
        status: 'streaming',
        text: event.text,
        heard: null,
        unsaid: '',
        firstTokenMs,
        firstAudioMs: null,
      };
      return appended({ ...state, nextId: state.nextId + 1, openIndex: state.lines.length, audioMarked: false }, line);
    }

    case 'assistant.audio.started': {
      const open = openLine(state);
      if (open === null || state.audioMarked) return state;
      const firstAudioMs = state.turnStartAt === null ? null : atMs(event.at) - state.turnStartAt;
      const line = { ...open.line, firstAudioMs };
      return { ...state, lines: replaceAt(state.lines, open.index, line), audioMarked: true };
    }

    case 'assistant.interrupted': {
      const open = openLine(state);
      if (open === null) return state;
      const line = { ...open.line, status: 'interrupted' as const };
      return withLines(state, replaceAt(state.lines, open.index, line));
    }

    case 'assistant.message': {
      const { entry } = event;
      const open = openLine(state);
      const cleared = { ...state, openIndex: null, audioMarked: false };
      if (entry.text === '') {
        // A stopped reply that never showed a word is not a line at all.
        if (open === null) return cleared;
        return withLines(cleared, removeAt(state.lines, open.index));
      }
      const interrupted = entry.spokenPrefix !== null;
      const heard = interrupted ? entry.spokenPrefix : null;
      const unsaid = interrupted && heard !== null && entry.text.startsWith(heard) ? entry.text.slice(heard.length) : '';
      if (open !== null) {
        const line: TranscriptLine = {
          kind: 'assistant',
          id: entry.id,
          at: entry.at,
          status: interrupted ? 'interrupted' : 'complete',
          text: entry.text,
          heard,
          unsaid,
          firstTokenMs: open.line.firstTokenMs,
          firstAudioMs: open.line.firstAudioMs,
        };
        return withLines(cleared, replaceAt(state.lines, open.index, line));
      }
      // No current line — an answer that never streamed a token — create one settled.
      const line: TranscriptLine = {
        kind: 'assistant',
        id: entry.id,
        at: entry.at,
        status: interrupted ? 'interrupted' : 'complete',
        text: entry.text,
        heard,
        unsaid,
        firstTokenMs: null,
        firstAudioMs: null,
      };
      return appended(cleared, line);
    }

    case 'state.changed': {
      if (event.to !== 'listening' && event.to !== 'idle') return state;
      const open = openLine(state);
      if (open === null || open.line.status !== 'streaming') return state;
      // Never settled, never interrupted: the reply was abandoned before anyone heard it.
      return { ...state, lines: removeAt(state.lines, open.index), openIndex: null, audioMarked: false };
    }

    case 'error': {
      if (event.scope === 'stt' && event.message === NOTHING_RECOGNISED) return state;
      const line: TranscriptLine = { kind: 'notice', id: `t-${state.nextId}`, at: event.at, text: `${SCOPE_LABEL[event.scope]} failed: ${event.message}` };
      return appended({ ...state, nextId: state.nextId + 1 }, line);
    }

    default:
      return state;
  }
}

/**
 * Plain text for Copy transcript (`docs/ui/transcript.md`): one line per entry, `You: …` /
 * `<characterName>: …`, an interrupted line as what was heard plus ` [interrupted]` (the
 * unsaid part is never copied), a notice as `[error] …`. Badges are never copied.
 */
export function transcriptToText(lines: readonly TranscriptLine[], characterName: string): string {
  return lines.map((line) => lineToText(line, characterName)).join('\n');
}

function lineToText(line: TranscriptLine, characterName: string): string {
  switch (line.kind) {
    case 'user':
      return `You: ${line.text}`;
    case 'notice':
      return `[error] ${line.text}`;
    case 'assistant':
      return line.status === 'interrupted' ? `${characterName}: ${line.heard ?? ''} [interrupted]` : `${characterName}: ${line.text}`;
  }
}
