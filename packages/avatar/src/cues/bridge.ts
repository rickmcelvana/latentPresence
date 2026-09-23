import type { ConversationEvent, InlineTag } from '@latentpresence/protocol';
import type { CuePerformer, PerformResult } from './performer';
import { scheduleCues } from './schedule';

/** How long the face keeps the last emote after she finishes an answer. */
export const RELEASE_AFTER_MS = 2500;

export interface FiredCue {
  readonly tag: InlineTag;
  /** When it was due and when it fired, on the caller's clock. */
  readonly dueAt: number;
  readonly firedAt: number;
  readonly result: PerformResult;
}

/**
 * The conversation bus → timed cues (P2-T07). A sentence's tags arrive with its text
 * (`assistant.sentence`), long before it is heard; they are placed in time only when its
 * audio starts (`assistant.audio.started` carries where the words are) and fired by
 * `update` from the frame loop — no timers, so a hidden tab that runs no frames fires
 * late rather than piling up, and a test drives it with a number.
 *
 * A barge-in drops everything not yet fired (those words were never said) and lets the
 * face go; a finished answer holds the last emote for `RELEASE_AFTER_MS`, then lets go.
 * A typed reply has no audio, so its tags never fire — P2-T08 gives it a voice.
 */
export class TagBridge {
  private readonly performer: CuePerformer;
  private readonly onFire: ((cue: FiredCue) => void) | undefined;
  private sentences = new Map<number, { text: string; tags: readonly InlineTag[] }>();
  private pending: { tag: InlineTag; dueAt: number }[] = [];
  private releaseAt: number | null = null;

  constructor(performer: CuePerformer, options: { readonly onFire?: (cue: FiredCue) => void } = {}) {
    this.performer = performer;
    this.onFire = options.onFire;
  }

  handle(event: ConversationEvent, now: number): void {
    switch (event.type) {
      case 'assistant.sentence':
        // Sentence indices restart with every reply; the first one starts a fresh map.
        if (event.index === 0) this.sentences = new Map();
        if (event.tags.length > 0) this.sentences.set(event.index, { text: event.text, tags: event.tags });
        return;
      case 'assistant.audio.started': {
        const sentence = this.sentences.get(event.sentenceIndex);
        if (sentence === undefined) return;
        this.sentences.delete(event.sentenceIndex);
        const timing = event.timing ?? { durationMs: 0, voicedStartMs: 0, voicedEndMs: 0 };
        for (const cue of scheduleCues(sentence.text, sentence.tags, timing)) {
          this.pending.push({ tag: cue.tag, dueAt: now + cue.atMs });
        }
        this.releaseAt = null;
        return;
      }
      case 'assistant.interrupted':
        this.pending = [];
        this.sentences = new Map();
        this.performer.release();
        return;
      case 'assistant.message':
        this.releaseAt = now + RELEASE_AFTER_MS;
        return;
      default:
    }
  }

  /** Fire whatever is due. Call once a frame, before `CuePerformer.update`. */
  update(now: number): void {
    const due = this.pending.filter((cue) => cue.dueAt <= now).toSorted((a, b) => a.dueAt - b.dueAt);
    this.pending = this.pending.filter((cue) => cue.dueAt > now);
    for (const cue of due) {
      const result = this.performer.perform(cue.tag);
      this.onFire?.({ tag: cue.tag, dueAt: cue.dueAt, firedAt: now, result });
    }
    if (this.releaseAt !== null && now >= this.releaseAt && this.pending.length === 0) {
      this.releaseAt = null;
      this.performer.release();
    }
  }
}
