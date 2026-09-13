import type { ConversationEvent, ConversationState } from '@latentpresence/protocol';

/** Any event that can arrive on the conversation bus (P1-T01). */
export type ConversationTrigger = ConversationEvent['type'];

/**
 * The conversation state machine's transition table (P1-T01). It is an explicit map
 * from `[current state, incoming event type]` to the next state, written down rather
 * than derived, so its shape survives review and every row is testable.
 *
 * Semantics of the interesting edges:
 * - `idle → listening` on `session.started`/`user.speech.started`/`user.message`: a turn
 *   can begin by waking the mic, being spoken at, or by a typed message.
 * - `listening → thinking` on `user.turn.ended`/`user.message`: an utterance is complete
 *   and is handed to the model.
 * - `thinking → listening` on `user.turn.resumed`: the turn end was provisional and the
 *   user carried on (ADR-25); the reply started for it is abandoned.
 * - `thinking → speaking` on `assistant.audio.started`: output becomes audible.
 * - Barge-in during `thinking`: nothing is audible, so `user.speech.started` cancels the
 *   pending reply and goes straight back to `listening`.
 * - Barge-in during `speaking` (P1-T08): **speech alone does not interrupt.** The voice
 *   ducks on speech start and the barge-in gate commits only once the user has kept
 *   talking, because the microphone also hears the character's own voice and a cough
 *   (`packages/core/src/reply/barge-in.ts`). The commit is `assistant.interrupted`,
 *   which carries what was heard, and passes through `interrupted` — the fade.
 * - `speaking → listening` on `assistant.message`: the answer has settled, every sentence
 *   played. Not `assistant.audio.ended`, which is per sentence: P1-T01 had the first
 *   sentence's end return to listening while the second was still playing.
 * - `thinking → listening` on `assistant.message` or `error`: an answer that settled
 *   without ever becoming audible — nothing recognised, no text, a failed model.
 * - `interrupted → thinking` on `user.turn.ended`: the barge-in itself was a complete
 *   short utterance, so it becomes the next input without waiting for the fade.
 * - `interrupted → listening` is not in the table: the machine leaves it when the
 *   `AudioOutPort` fade completes, or on its teardown timer when there is no port.
 * - `session.ended` returns to `idle` from any active state; the caller chooses the
 *   reason (`user` | `idle` | `error`).
 *
 * Anything not listed here leaves the machine where it is: progress events
 * (`assistant.token`, `user.transcript`), tool and affect traffic pass through the bus
 * but do not move state. The table is a partial map per state by intent.
 */
export const transitionTable: Readonly<
  Record<ConversationState, Readonly<Partial<Record<ConversationTrigger, ConversationState>>>>
> = {
  idle: {
    'session.started': 'listening',
    'user.speech.started': 'listening',
    'user.message': 'thinking',
  },
  listening: {
    'user.turn.ended': 'thinking',
    'user.message': 'thinking',
    'session.ended': 'idle',
  },
  thinking: {
    'assistant.audio.started': 'speaking',
    // Barge-in before any audio exists: nothing audible to tear down.
    'user.speech.started': 'listening',
    // ADR-25: the turn end was provisional and the user kept talking.
    'user.turn.resumed': 'listening',
    // Settled without ever being audible.
    'assistant.message': 'listening',
    error: 'listening',
    'session.ended': 'idle',
  },
  speaking: {
    // The whole answer has played. Not `assistant.audio.ended`, which is per sentence.
    'assistant.message': 'listening',
    // The barge-in gate committed (P1-T08); speech alone only ducks.
    'assistant.interrupted': 'interrupted',
    'session.ended': 'idle',
  },
  interrupted: {
    'user.turn.ended': 'thinking',
    'session.ended': 'idle',
  },
};

/**
 * Apply an incoming event type to a state. Returns the declared next state, or the
 * current state when the event is not a state-affecting transition for the caller
 * (a no-op). Pure: always returns a member of `ConversationState`.
 */
export function transition(state: ConversationState, trigger: ConversationTrigger): ConversationState {
  return transitionTable[state][trigger] ?? state;
}
