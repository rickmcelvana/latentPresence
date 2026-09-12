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
 * - `thinking → speaking` on `assistant.audio.started`: output becomes audible.
 * - Barge-in: when the user starts talking while the model is still `thinking`, nothing
 *   is being spoken, so we simply cancel the pending reply and go straight back to
 *   `listening`. When the user barges in while the assistant is `speaking`, audio is
 *   playing and must be torn down, so we pass through the explicit `interrupted` state
 *   (the machine's fade-out seam, driven by a teardown timer) before returning to
 *   `listening`.
 * - `speaking → listening` on `assistant.audio.ended` is the natural end of a turn:
 *   back to hearing the user.
 * - `interrupted → thinking` on `user.turn.ended`: the barge-in itself was a complete
 *   short utterance, so it becomes the next input without waiting for the teardown.
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
    'session.ended': 'idle',
  },
  speaking: {
    'assistant.audio.ended': 'listening',
    // Barge-in while audio is playing goes through the explicit interrupted state.
    'user.speech.started': 'interrupted',
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
