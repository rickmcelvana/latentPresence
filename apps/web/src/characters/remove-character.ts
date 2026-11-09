import type { Forgotten, MemoryStore } from '@latentpresence/protocol';
import type { CharacterShelf } from './character-shelf';

/** What deleting a character took: its schedules always, and everything it remembered when asked. */
export interface Removed {
  readonly schedules: number;
  /** Null when what it remembers was kept (or there is no memory to forget it from). */
  readonly forgotten: Forgotten | null;
}

/**
 * Deleting one of the person's characters (P11-T03, P11-T04; ADR-74 items 7 and 8). Its schedules go
 * first, from whichever store holds them: a schedule whose character is gone would fire as Alice.
 * Asked to forget, the store takes everything under the id in one call (`forgetCharacter`, which
 * takes the schedules too). The character leaves the shelf last, so a failure on the way leaves it
 * there to try again. The caller takes it out of Settings (`withoutCharacter`).
 */
export async function removeCharacter(id: string, deps: { readonly shelf: CharacterShelf; readonly memory: MemoryStore | null; readonly forget: boolean }): Promise<Removed> {
  let removed: Removed = { schedules: 0, forgotten: null };
  if (deps.memory !== null && deps.forget) {
    const forgotten = await deps.memory.forgetCharacter(id);
    removed = { schedules: forgotten.schedules, forgotten };
  } else if (deps.memory !== null) {
    const schedules = await deps.memory.listSchedules(id);
    for (const schedule of schedules) await deps.memory.deleteSchedule(schedule.id);
    removed = { schedules: schedules.length, forgotten: null };
  }
  await deps.shelf.remove(id);
  return removed;
}

function counted(count: number, one: string, many: string): string | null {
  return count === 0 ? null : count === 1 ? `one ${one}` : `${count.toLocaleString('en')} ${many}`;
}

function listed(parts: readonly string[]): string {
  return parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

/** What the page says after a delete, in words. */
export function removedWords(name: string, removed: Removed): string {
  const schedules = counted(removed.schedules, 'schedule', 'schedules');
  if (removed.forgotten === null) return schedules === null ? `${name} was deleted.` : `${name} was deleted, with ${schedules}.`;
  const { episodes, facts, plans, blocks } = removed.forgotten;
  const parts = [counted(episodes, 'turn', 'turns'), counted(facts, 'fact', 'facts'), counted(plans, 'plan', 'plans'), counted(blocks, 'note', 'notes'), schedules].filter((part) => part !== null);
  return parts.length === 0 ? `${name} was deleted; they had nothing to remember.` : `${name} was deleted, and what they remembered is gone: ${listed(parts)}.`;
}
