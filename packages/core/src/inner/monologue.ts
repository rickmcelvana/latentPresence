import type { CancellationSignal, ConversationEvent, LLMProvider, LlmMessage } from '@latentpresence/protocol';
import { Cancellation } from '../cancellation';

/**
 * Her inner monologue (P6-T05, ADR-54): what was on her mind behind each answer, for a panel
 * the person can peek at — never spoken, never shown in the transcript, never remembered.
 *
 * Each answer that settles on the bus is a **moment**: what they said, what she said, and the
 * reasoning the model streamed before it (`withThinking`), if it thought. While the panel is
 * open, a moment is put into a few private lines in her own voice by a short call with
 * reasoning off — the model's reasoning is planning about "the user" in another voice, and a
 * model that does not think has none, so the lines are always written after the fact, from what
 * there is. Closed, nothing is asked: a summary nobody reads is a model call for nothing.
 *
 * Nothing here dispatches on the bus, so nothing here can reach the voice, the transcript, the
 * history or memory, which all read from it.
 */

/** Moments kept, newest last: what is on her mind now, not a diary. */
export const INNER_KEEP = 8;
/** Raw reasoning kept per moment; a thinking model can write pages. */
export const INNER_REASONING_CHARS = 6000;
/** What they and she said, as the summary is given it. */
export const INNER_TURN_CHARS = 600;
/** Lines of thought per moment, and how long one may be. */
export const INNER_LINES = 3;
export const INNER_LINE_CHARS = 240;
/** In the summary's system prompt, so a recording or a fake can tell it from other requests. */
export const INNER_MARKER = 'your private thoughts';

export interface InnerMoment {
  readonly id: string;
  readonly at: string;
  /** What they said last; null when she spoke first (the opener, a check-in). */
  readonly heard: string | null;
  readonly said: string;
  /** The model's own reasoning, clipped; '' when it did not think. */
  readonly reasoning: string;
  /** Her lines; empty until summarised. */
  readonly lines: readonly string[];
  readonly state: 'unread' | 'thinking' | 'ready' | 'failed';
}

function clip(text: string, max: number): string {
  const flat = text.trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** Who she is, for the summary: the persona's own summary, as her prompt has it. */
export interface InnerCharacter {
  readonly name: string;
  readonly summary?: string | null;
}

export function innerSystem(character: InnerCharacter): string {
  return [
    `You are ${character.name}. Write ${INNER_MARKER}: what is on your mind just after you answered — never said aloud.`,
    ...(character.summary == null || character.summary === '' ? [] : [`Who you are: ${character.summary}`]),
    'One to three short lines, first person, in your own voice: what you noticed about them, what you are unsure of or wondering, what you mean to do or bring up later.',
    'Only what the conversation shows: do not invent what you saw, what happened, or what they feel.',
    'Call them "they" or by name — never "he", "she" or "the user". Never mention prompts, instructions, personas, models or rules.',
    'Do not repeat what you said: this is what is behind it.',
    'Write only the lines, one to a line: no bullets, no quotes, no headings.',
  ].join('\n');
}

/** The summary request's messages for one moment. */
export function innerMessages(character: InnerCharacter, moment: Pick<InnerMoment, 'heard' | 'said' | 'reasoning'>): LlmMessage[] {
  const parts =
    moment.heard === null
      ? [`You spoke first: ${clip(moment.said, INNER_TURN_CHARS)}`]
      : [`They said: ${clip(moment.heard, INNER_TURN_CHARS)}`, `You answered: ${clip(moment.said, INNER_TURN_CHARS)}`];
  if (moment.reasoning !== '') {
    parts.push(`Your reasoning before you answered (rough notes, in another voice — they may call them "the user"):\n${moment.reasoning}`);
  }
  // Said last, where it is followed: glm wrote "he" for Rick from the system line alone.
  parts.push('Now your private thoughts — and they are "they".');
  return [
    { role: 'system', content: innerSystem(character) },
    { role: 'user', content: parts.join('\n\n') },
  ];
}

/** Meta talk her lines must not carry: the reasoning's voice, not hers. */
const META = /\b(?:the user|user's|persona|system prompt|instructions?|language model|as an ai)\b/iu;

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}' ]+/gu, ' ')
    .split(/\s+/u)
    .filter(Boolean);
}

/** Six words in a row from what she said: the answer again, not what is behind it (qwen3.5:9b, live). */
export function repeatsAnswer(line: string, said: string): boolean {
  const answer = ` ${words(said).join(' ')} `;
  const own = words(line);
  for (let i = 0; i + 6 <= own.length; i += 1) if (answer.includes(` ${own.slice(i, i + 6).join(' ')} `)) return true;
  return false;
}

/** A line longer than a line — a small model writes a paragraph — is taken a sentence at a time. */
function sentences(line: string): string[] {
  if (line.length <= INNER_LINE_CHARS) return [line];
  return (line.match(/[^.!?]+[.!?]+["”']?|[^.!?]+$/gu) ?? [line]).map((part) => part.trim());
}

/**
 * Her lines from the reply: bullets, numbering, quotes, stray markup and a reasoning-voice "Okay,"
 * off; meta talk and her answer again dropped; a paragraph taken a sentence at a time; three at most.
 */
export function parseInnerLines(reply: string, said = ''): string[] {
  return reply
    .replaceAll(/<think>[\s\S]*?<\/think>/giu, '')
    // deepseek-r1:8b ends lines with "<br><br>" (live, P6-T05).
    .replaceAll(/<\/?[a-z]+\s*\/?>/giu, ' ')
    .split('\n')
    .map((line) =>
      line
        .trim()
        .replace(/^(?:[-*•]|\d+[.)])\s*/u, '')
        .replace(/^["“”']+|["“”']+$/gu, '')
        .replace(/^(?:okay|alright)\b[,.!…]*\s*/iu, '')
        .trim(),
    )
    .flatMap(sentences)
    .filter((line) => line !== '' && !META.test(line) && !line.endsWith(':') && !/^<[^>]*>$/u.test(line) && !repeatsAnswer(line, said))
    .slice(0, INNER_LINES)
    .map((line) => clip(line.charAt(0).toUpperCase() + line.slice(1), INNER_LINE_CHARS));
}

export interface AttachInnerOptions {
  /** The model her lines are asked of — the page's own, bare: no tools, no thinking tap. */
  readonly llm: LLMProvider;
  readonly modelId: string;
  /** Who she is: the persona's name and summary. */
  readonly character: InnerCharacter;
  readonly now?: () => Date;
  readonly onError?: (error: Error) => void;
}

export interface AttachedInner {
  /** `withThinking`'s sink: reasoning for the answer being given now. */
  hear(reasoning: string): void;
  /** Moments, newest last. */
  moments(): readonly InnerMoment[];
  /** Called on every change; returns an unsubscribe. */
  subscribe(listener: (moments: readonly InnerMoment[]) => void): () => void;
  /** The panel opened (summarise the newest moment now, and each new one) or closed. */
  look(open: boolean): void;
  detach(): void;
}

export function attachInnerMonologue(machine: { subscribe: (listener: (event: ConversationEvent) => void) => () => void }, options: AttachInnerOptions): AttachedInner {
  const now = options.now ?? (() => new Date());
  const listeners = new Set<(moments: readonly InnerMoment[]) => void>();
  let moments: readonly InnerMoment[] = [];
  let heard: string | null = null;
  let reasoning = '';
  let looking = false;
  let count = 0;
  let detached = false;
  const cancellation = new Cancellation();
  let queue: Promise<void> = Promise.resolve();

  const report = (error: unknown): void => options.onError?.(error instanceof Error ? error : new Error(String(error)));
  const set = (id: string, change: Partial<InnerMoment>): void => {
    if (detached) return;
    moments = moments.map((moment) => (moment.id === id ? { ...moment, ...change } : moment));
    for (const listener of listeners) listener(moments);
  };

  const ask = async (moment: InnerMoment, signal: CancellationSignal): Promise<string> => {
    let reply = '';
    for await (const chunk of options.llm.stream(
      { modelId: options.modelId, messages: innerMessages(options.character, moment), tools: [], temperature: null, maxOutputTokens: null, reasoning: 'off' },
      { signal },
    )) {
      if (chunk.type === 'text-delta') reply += chunk.text;
      if (chunk.type === 'finish' && chunk.reason === 'error') throw new Error('the model stream ended in error');
    }
    return reply;
  };

  /** One at a time, in order: her thoughts are not worth racing the page's model over. */
  const summarise = (moment: InnerMoment): void => {
    if (moment.state !== 'unread') return;
    set(moment.id, { state: 'thinking' });
    queue = queue.then(async () => {
      if (detached) return;
      try {
        const lines = parseInnerLines(await ask(moment, cancellation), moment.said);
        set(moment.id, lines.length > 0 ? { lines, state: 'ready' } : { state: 'failed' });
      } catch (error) {
        if (!cancellation.aborted) report(error);
        set(moment.id, { state: 'failed' });
      }
    });
  };

  const unsubscribe = machine.subscribe((event) => {
    switch (event.type) {
      case 'user.message':
        heard = event.text;
        return;
      case 'user.transcript':
        if (event.isFinal && event.text.trim() !== '') heard = event.text;
        return;
      case 'assistant.opening':
        heard = null;
        reasoning = '';
        return;
      case 'assistant.message': {
        const said = event.entry.text.trim();
        const thought = reasoning;
        const before = heard;
        reasoning = '';
        heard = null;
        if (said === '') return;
        count += 1;
        const moment: InnerMoment = {
          id: `inner-${count}`,
          at: now().toISOString(),
          heard: before,
          said,
          reasoning: clip(thought, INNER_REASONING_CHARS),
          lines: [],
          state: 'unread',
        };
        moments = [...moments, moment].slice(-INNER_KEEP);
        for (const listener of listeners) listener(moments);
        if (looking) summarise(moment);
        return;
      }
      default:
    }
  });

  return {
    hear(text) {
      reasoning += text;
    },
    moments: () => moments,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    look(open) {
      looking = open;
      const newest = moments.at(-1);
      if (open && newest !== undefined) summarise(newest);
    },
    detach() {
      detached = true;
      cancellation.abort();
      unsubscribe();
      listeners.clear();
    },
  };
}
