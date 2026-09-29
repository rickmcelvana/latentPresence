import type { ConversationEvent } from '@latentpresence/protocol';
import type { AttachedAffect } from '../affect/attach';
import { parseAffect, serializeAffect } from '../affect/persist';
import type { SelfNotes } from './notes';

/**
 * Her mood across visits (P4-T06, ADR-40): the affect engine's state, saved in the system
 * block `_mood` and restored at the start of the next visit **advanced by the time between**
 * (`AffectEngine.restore`, P3-T01's decay) — left upset a minute ago she is still upset;
 * after a week she is herself again.
 *
 * **Saved after every answer**, not "at session end": a browser tab has no end it reliably
 * reports (a closed tab gets no time to write to IndexedDB, let alone to a companion), so the
 * last answer is the last moment worth keeping. `save()` is there for a `pagehide` best effort.
 *
 * **Restored only before anything is felt:** a message that arrives before the store answers
 * wins over the saved mood, and nothing is saved until the restore has had its say — or the
 * baseline would overwrite the mood it was about to restore.
 */
export const MOOD_BLOCK = '_mood';

export interface AttachedMood {
  /** Whether the saved mood was taken; false when there was none, it was unreadable, or she had already felt something. */
  readonly restored: Promise<boolean>;
  /** Save the mood now. Waits for the restore; never throws — failures go to `onError`. */
  save(): Promise<void>;
  detach(): void;
}

export function attachMood(
  machine: { subscribe: (listener: (event: ConversationEvent) => void) => () => void },
  options: {
    readonly affect: AttachedAffect;
    readonly notes: SelfNotes;
    readonly now?: () => number;
    readonly onError?: (error: Error) => void;
  },
): AttachedMood {
  const { affect, notes } = options;
  const now = options.now ?? Date.now;
  const report = (error: unknown): void => options.onError?.(error instanceof Error ? error : new Error(String(error)));

  const restored = (async () => {
    try {
      await notes.load();
      const saved = notes.system(MOOD_BLOCK);
      return saved === null ? false : affect.engine.restore(parseAffect(saved), now());
    } catch (error) {
      report(error);
      return false;
    }
  })();

  let saving: Promise<void> = restored.then(() => undefined);
  const save = (): Promise<void> => {
    saving = saving.then(async () => {
      try {
        await notes.writeSystem(MOOD_BLOCK, serializeAffect(affect.engine.tick(now())));
      } catch (error) {
        report(error);
      }
    });
    return saving;
  };

  const unsubscribe = machine.subscribe((event) => {
    if (event.type === 'assistant.message') void save();
  });

  return { restored, save, detach: unsubscribe };
}
