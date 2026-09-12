import type { ConversationEvent } from '@latentpresence/protocol';

/** A subscriber to the conversation bus. */
export type ConversationListener = (event: ConversationEvent) => void;

/**
 * A typed, synchronous, in-process event bus for `ConversationEvent`s (P1-T01). Every
 * kind of happening on a conversation passes through here: the state machine, the
 * transcript panel, the affect engine and the memory writer all read the same stream.
 * No DOM, no audio, no timers.
 */
export interface ConversationBus {
  /** Subscribe to every event. Returns an unsubscribe function. */
  subscribe(listener: ConversationListener): () => void;
  /** Deliver an event to all current subscribers, in subscription order. */
  emit(event: ConversationEvent): void;
}

export function createConversationBus(): ConversationBus {
  const listeners = new Set<ConversationListener>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(event) {
      // Snapshot before iterating so a subscriber that unsubscribes, or subscribes,
      // while handling an event does not disturb this delivery.
      for (const listener of Array.from(listeners)) {
        listener(event);
      }
    },
  };
}
