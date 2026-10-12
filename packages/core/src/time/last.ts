import type { MemoryStore, PromptContext } from '@latentpresence/protocol';

/**
 * Their last conversation, read from the store she already has (P6-T02, ADR-51), and whether
 * she should speak first now.
 */

export type LastConversation = NonNullable<PromptContext['since']>;

/** How many turns of the last conversation her prompt keeps: enough to know how it ended. */
export const LAST_TURNS = 6;
/** Longer turns are cut: this is a reminder of how it ended, not the conversation again. */
export const LAST_TURN_CHARS = 280;
/**
 * She speaks first when they come back after this long. Within it, a reload is not a return: she
 * would greet someone who never left.
 */
export const OPENING_AFTER_MS = 60 * 60 * 1000;

function clip(text: string): string {
  const flat = text.replaceAll(/\s+/gu, ' ').trim();
  return flat.length <= LAST_TURN_CHARS ? flat : `${flat.slice(0, LAST_TURN_CHARS - 1).trimEnd()}…`;
}

/**
 * The newest earlier session with a turn of theirs in it — a visit where only she spoke (an
 * opener they never answered) is not a conversation — and its last turns, oldest first. Read
 * from the first page of `listEpisodes` (newest fifty), which a last conversation's ending is
 * always in. Null when they have never talked.
 */
export async function lastConversation(store: Pick<MemoryStore, 'listEpisodes'>, characterId: string, currentSessionId: string): Promise<LastConversation | null> {
  const episodes = await store.listEpisodes(characterId, null);
  const theirs = episodes.find((episode) => episode.sessionId !== currentSessionId && episode.role === 'user');
  if (theirs === undefined) return null;
  const session = episodes.filter((episode) => episode.sessionId === theirs.sessionId && episode.text.trim() !== '');
  const newest = session[0];
  if (newest === undefined) return null;
  return {
    at: newest.at,
    turns: session
      .slice(0, LAST_TURNS)
      .toReversed()
      .map((episode) => ({ role: episode.role, text: clip(episode.text) })),
  };
}

/** She speaks first: they have talked before, and not within the hour. */
export function shouldOpen(last: LastConversation | null, now: Date): boolean {
  return last !== null && now.getTime() - Date.parse(last.at) >= OPENING_AFTER_MS;
}
