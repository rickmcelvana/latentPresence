import type { MemoryStore, SelfModelBlock } from '@latentpresence/protocol';

/**
 * The character's own notes (P4-T06, ADR-40): self-model blocks she reads in her prompt and
 * edits with `self_write_block` — what she has come to think about herself and about the
 * person, in her words.
 *
 * **Blocks whose name starts with `_` are the system's** (`_mood`): machine JSON, never
 * rendered into the prompt, never offered to her tools, never overwritten by them.
 *
 * Held in the page like the kernel's facts (ADR-17): loaded once, kept in step by its own
 * writes, so the prompt reads them synchronously.
 */

/** Prefix of the blocks the system keeps for itself. */
export const SYSTEM_BLOCK_PREFIX = '_';
/** A note's name: short, lowercase, words joined by underscores — what a model writes reliably. */
export const NOTE_NAME = /^[a-z][a-z0-9_]{0,40}$/u;
/** The companion's default block limit (migration 0002), kept everywhere so no store is roomier. */
export const NOTE_CHAR_LIMIT = 2000;
/** How many notes she may keep: every one is in every prompt. */
export const MAX_NOTES = 8;

export function isSystemBlock(name: string): boolean {
  return name.startsWith(SYSTEM_BLOCK_PREFIX);
}

export interface SelfNote {
  readonly name: string;
  readonly content: string;
  /** False for a note only the person may change (a hard boundary, set elsewhere). */
  readonly editable: boolean;
}

export class SelfNotes {
  readonly characterId: string;
  private readonly store: MemoryStore;
  private readonly now: () => Date;
  private blocks = new Map<string, SelfModelBlock>();
  private loaded: Promise<void> | null = null;

  constructor(options: { readonly store: MemoryStore; readonly characterId: string; readonly now?: () => Date }) {
    this.store = options.store;
    this.characterId = options.characterId;
    this.now = options.now ?? (() => new Date());
  }

  /** Read the character's blocks once; later calls wait on the same read. */
  load(): Promise<void> {
    this.loaded ??= this.store.readBlocks(this.characterId).then(
      (blocks) => {
        this.blocks = new Map(blocks.map((block) => [block.name, block]));
      },
      (error: unknown) => {
        // A failed read is forgotten so the next use tries again (R-27, 2026-10-09).
        this.loaded = null;
        throw error;
      },
    );
    return this.loaded;
  }

  /** Her notes, by name, without the system's blocks. Empty until loaded. Never waits. */
  notes(): SelfNote[] {
    return [...this.blocks.values()]
      .filter((block) => !isSystemBlock(block.name))
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((block) => ({ name: block.name, content: block.content, editable: block.editableByCharacter }));
  }

  /** A system block's content (`_mood`), or null. */
  system(name: string): string | null {
    return isSystemBlock(name) ? (this.blocks.get(name)?.content ?? null) : null;
  }

  /** Write a system block (`_mood`): the system's own, never the character's. */
  async writeSystem(name: string, content: string): Promise<void> {
    if (!isSystemBlock(name)) throw new Error(`${name} is not a system block`);
    await this.put({ characterId: this.characterId, name, content, updatedAt: this.now().toISOString(), editableByCharacter: false });
  }

  /**
   * Her write, from `self_write_block`: refused, with a reason she can read, for a system
   * name, a name that is not a plain lowercase word, a note only the person may change, one
   * too long, or a ninth note. An empty `content` removes nothing — it writes an empty note.
   */
  async writeNote(name: string, content: string): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
    await this.load();
    if (isSystemBlock(name) || !NOTE_NAME.test(name)) return { ok: false, reason: `"${name}" is not a name you can use: lowercase letters, digits and underscores, starting with a letter.` };
    const existing = this.blocks.get(name);
    if (existing !== undefined && !existing.editableByCharacter) return { ok: false, reason: `"${name}" is one only the person can change.` };
    if (content.length > NOTE_CHAR_LIMIT) return { ok: false, reason: `That is ${content.length} characters; a note holds ${NOTE_CHAR_LIMIT}. Say it shorter.` };
    if (existing === undefined && this.notes().length >= MAX_NOTES) {
      return { ok: false, reason: `You already keep ${MAX_NOTES} notes (${this.notes().map((note) => note.name).join(', ')}). Rewrite one of them instead.` };
    }
    await this.put({ characterId: this.characterId, name, content, updatedAt: this.now().toISOString(), editableByCharacter: true });
    return { ok: true };
  }

  private async put(block: SelfModelBlock): Promise<void> {
    await this.store.writeBlock(block);
    this.blocks.set(block.name, block);
  }
}
