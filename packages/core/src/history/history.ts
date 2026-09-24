import type { ConversationEvent, LlmMessage } from '@latentpresence/protocol';
import { emptyTranscript, reduceTranscript, type TranscriptLine, type TranscriptState } from '../transcript/transcript';

/**
 * What the model is told happened (P1-T12b).
 *
 * **It is a projection of the transcript, not a second reducer, and that is the point.**
 * The transcript already answers the only hard question here — what actually reached the
 * user — with ADR-25's retraction rule and ADR-26's spoken prefix in it. Keeping a
 * parallel copy of that logic is how the panel and the model's memory would come to
 * disagree, and a character that believes it said something the user never heard is worse
 * than one with no memory at all.
 *
 * So the rules are inherited rather than restated:
 *
 * - **An interrupted answer is remembered as what was heard**, never as what was
 *   generated. Ask "what did you just say?" after a barge-in and the model can only
 *   repeat the words that reached the ear.
 * - **A retracted turn (ADR-25) is not in it**, because it never reached the bus.
 * - **An answer nobody heard any of is not in it**, and neither is a backchannel.
 * - **A failure notice is not in it.** "The language model failed" is something the *app*
 *   said to the user, not something the character said, and replaying it to the model
 *   invites it to apologise for an error it did not make.
 *
 * Why this exists at all: R-6 (2026-09-21) found `ChatSession` keeping history correctly
 * and the spoken path keeping none, so P1-T13 would have shipped a voice with no memory
 * between turns. `docs/TASKS.md` D-21.
 */

/** A fixed prompt, or one rendered each time a request is built. */
export type SystemPrompt = string | (() => string);

export interface ConversationHistoryOptions {
  /**
   * The persona prompt (P1-T12). Sent first, and never counted against `maxTurns`. A
   * function is asked on every request (P3-T09), so what is true right now — her mood —
   * is read when the model is called, not when the page mounted.
   */
  readonly system?: SystemPrompt | null;
  /**
   * How many messages of conversation to keep, newest first. Context is finite and a long
   * call is unbounded; P4 replaces this with retrieval. Default 40 — twenty exchanges,
   * comfortably inside every catalog context length while being more than a person
   * refers back to in one sitting.
   */
  readonly maxMessages?: number;
}

const DEFAULT_MAX_MESSAGES = 40;

/**
 * Turns settled transcript lines into the messages a model is sent.
 *
 * Pure, and exported on its own so P4 can reuse it and so the rules can be tested without
 * a machine, a bus or a clock.
 */
export function historyFromTranscript(lines: readonly TranscriptLine[], maxMessages = DEFAULT_MAX_MESSAGES): LlmMessage[] {
  const messages: LlmMessage[] = [];
  for (const line of lines) {
    if (line.kind === 'notice') continue;
    if (line.kind === 'user') {
      append(messages, { role: 'user', content: line.text });
      continue;
    }
    // Still streaming: not settled, so not yet something the character has said.
    if (line.status === 'streaming') continue;
    // The heard-not-meant rule, and the whole reason this is not `line.text`.
    const said = line.status === 'interrupted' ? (line.heard ?? '') : line.text;
    if (said.trim() === '') continue;
    append(messages, { role: 'assistant', content: said, toolCalls: [] });
  }
  return trim(messages, maxMessages);
}

/**
 * Adds a message, merging it into the last one when the roles match.
 *
 * Consecutive same-role messages are real here — a user who speaks twice while the
 * character is thinking gets two user lines and one answer — and **Anthropic rejects a
 * prompt that does not alternate**, so merging is not tidiness, it is the difference
 * between a working request and a 400 on the provider the catalog calls enriched.
 */
function append(messages: LlmMessage[], message: LlmMessage): void {
  const last = messages.at(-1);
  if (last !== undefined && last.role === message.role && 'content' in last && 'content' in message) {
    messages[messages.length - 1] = { ...last, content: `${last.content}\n${message.content}` } as LlmMessage;
    return;
  }
  messages.push(message);
}

/**
 * Keeps the newest `maxMessages`, and never lets the window open on an assistant message:
 * a conversation that starts with the character answering nothing reads as a missing turn,
 * and some providers reject it outright.
 */
function trim(messages: readonly LlmMessage[], maxMessages: number): LlmMessage[] {
  const kept = messages.slice(Math.max(0, messages.length - maxMessages));
  while (kept.length > 0 && kept[0]?.role === 'assistant') kept.shift();
  return kept;
}

/**
 * The conversation so far, kept by watching the bus.
 *
 * Both `ChatSession` and `VoiceSession` share one of these, which is what makes a typed
 * message and a spoken one land in the same history. It subscribes rather than being
 * written to, so it cannot drift from the transcript the user is reading, and events are
 * delivered synchronously — a message dispatched is a message already in `messages`.
 */
export class ConversationHistory {
  private state: TranscriptState = emptyTranscript();
  private readonly maxMessages: number;
  /** The persona prompt, or how to render it per request. Mutable: P4 rewrites it between turns. */
  system: SystemPrompt | null;

  constructor(options: ConversationHistoryOptions = {}) {
    this.system = options.system ?? null;
    this.maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
  }

  /** Feed one bus event. Safe to pass every event; the ones that matter are picked out. */
  observe(event: ConversationEvent): void {
    this.state = reduceTranscript(this.state, event);
  }

  /** The conversation so far, without `system`. */
  get messages(): LlmMessage[] {
    return historyFromTranscript(this.state.lines, this.maxMessages);
  }

  /**
   * The messages for a request, with `system` first.
   *
   * `pendingUser` is a turn that has not reached the bus yet, which the spoken path always
   * has: ADR-25 starts the reply while the turn can still be retracted, so its words are
   * deliberately held back from the bus until `confirmedAt`. Without this the model would
   * answer the question before last.
   */
  request(pendingUser?: string): LlmMessage[] {
    const said = pendingUser?.trim() ?? '';
    const messages = this.messages;
    if (said !== '') append(messages, { role: 'user', content: said });
    const system = typeof this.system === 'function' ? this.system() : this.system;
    return system === null ? messages : [{ role: 'system', content: system }, ...messages];
  }

  /** Forget everything said so far. `system` is kept: it is who the character is, not what happened. */
  clear(): void {
    this.state = emptyTranscript();
  }
}

/**
 * Builds a history and subscribes it to a machine, returning both it and the unsubscribe.
 *
 * Use this when one history is shared between a `ChatSession` and a `VoiceSession`:
 * **whoever creates a shared history owns its subscription**, because a history watching
 * the same bus twice would count every message twice. A session given a history assumes
 * it is already attached; a session given none makes and attaches its own.
 */
export function attachHistory(
  machine: { subscribe: (listener: (event: ConversationEvent) => void) => () => void },
  options: ConversationHistoryOptions = {},
): { readonly history: ConversationHistory; readonly detach: () => void } {
  const history = new ConversationHistory(options);
  const detach = machine.subscribe((event) => history.observe(event));
  return { history, detach };
}

