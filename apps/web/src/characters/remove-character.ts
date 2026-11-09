import type { MemoryStore } from '@latentpresence/protocol';
import type { CharacterShelf } from './character-shelf';

/**
 * Deleting one of the person's characters (P11-T03, ADR-74 item 7). Its schedules go first, from
 * whichever store holds them: a schedule whose character is gone would fire as Alice. The character
 * leaves the shelf last, so a failure on the way leaves it there to try again. What it remembers
 * stays under its id (forgetting it is P11-T04); the caller takes it out of Settings
 * (`withoutCharacter`).
 */
export async function removeCharacter(id: string, deps: { readonly shelf: CharacterShelf; readonly memory: MemoryStore | null }): Promise<{ readonly schedules: number }> {
  const schedules = deps.memory === null ? [] : await deps.memory.listSchedules(id);
  for (const schedule of schedules) await deps.memory?.deleteSchedule(schedule.id);
  await deps.shelf.remove(id);
  return { schedules: schedules.length };
}
