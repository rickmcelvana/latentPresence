import { TAG_PATTERN, TAG_SCAN_LIMIT } from './chunker';

/**
 * Keeps inline tags out of the token stream (P1-T12).
 *
 * The chunker already lifts `[emote:x]` and `[gesture:x]` out of *spoken* text, but a
 * transcript streams `assistant.token` as it arrives — so before this, a viewer watched
 * `[emote:joy]` appear and then vanish when the sentence settled (`docs/ui/transcript.md`
 * named that as P1-T12's to fix).
 *
 * **The whole problem is that a tag arrives in pieces.** A model emits `[emo`, `te:jo`,
 * `y]` across three deltas, so a filter that only looked at one delta would pass every
 * fragment through. This holds back any trailing text that could still become a tag, and
 * releases it as soon as it cannot.
 *
 * Deliberately the *same* grammar and the same 48-character scan limit as the chunker,
 * imported rather than rewritten: two copies of this regex that drifted apart would show
 * up as text the transcript hides and the speech says, or the reverse.
 *
 * It does not parse tags — the chunker does that, from the unfiltered text, and is still
 * the only thing that produces `InlineTag`s. This only decides what is safe to show yet.
 */
export class TagFilter {
  /** Text that might still turn out to be the start of a tag. */
  private held = '';
  /**
   * The last character actually shown, across the whole stream — `''` before anything is.
   * Needed because a tag's surrounding spaces are split across deltas as readily as the
   * tag itself: `Hello` then `[emote:joy] world` must not become `Helloworld`, and
   * `Hello ` then `[emote:joy] world` must not become `Hello  world`.
   */
  private lastShown = '';
  /**
   * A tag was just removed and the space that followed it has not arrived yet. One
   * character per delta is a real stream shape, so the `]` and the space after it land in
   * different calls and this cannot be handled inside one.
   */
  private trimAfterTag = false;

  /** Feed one delta; get back what is safe to show. May be empty. */
  push(text: string): string {
    let buffer = this.held + text;
    this.held = '';
    let out = '';
    const show = (raw: string): void => {
      let piece = raw;
      if (this.trimAfterTag) {
        // As the chunker does: one space survives a removed tag, and an answer that
        // opens with a tag does not open with the space that followed it.
        while (piece.length > 0 && isSpace(piece.charAt(0)) && (this.lastShown === '' || isSpace(this.lastShown))) {
          piece = piece.slice(1);
        }
        if (piece !== '') this.trimAfterTag = false;
      }
      if (piece === '') return;
      out += piece;
      this.lastShown = piece.charAt(piece.length - 1);
    };
    for (;;) {
      const open = buffer.indexOf('[');
      if (open === -1) {
        show(buffer);
        return out;
      }
      show(buffer.slice(0, open));
      const rest = buffer.slice(open);
      const match = TAG_PATTERN.exec(rest);
      if (match !== null) {
        buffer = rest.slice(match[0].length);
        this.trimAfterTag = true;
        continue;
      }
      // Not a tag yet. Long enough to be sure, or already closed: it is literal text.
      if (rest.length >= TAG_SCAN_LIMIT || rest.includes(']')) {
        show('[');
        buffer = rest.slice(1);
        continue;
      }
      // Still growing: hold it and wait for the next delta.
      this.held = rest;
      return out;
    }
  }

  /**
   * The stream ended. Anything still held was never a tag — an answer that ends `[` is
   * an answer that ends `[`, and swallowing it would lose a character the user saw the
   * model write.
   */
  flush(): string {
    const rest = this.held;
    this.held = '';
    if (rest !== '') this.lastShown = rest.charAt(rest.length - 1);
    return rest;
  }
}

const isSpace = (ch: string): boolean => ch === ' ' || ch === '	';
