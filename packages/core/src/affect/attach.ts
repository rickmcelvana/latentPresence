import type { AffectState, ConversationEvent, InlineTag } from '@latentpresence/protocol';
import { AffectEngine, affectInputsFrom, dominantEmotion, initialAffect } from './engine';
import { affectToVoice, type VoiceStyle } from './express';
import { DEFAULT_AFFECT_PARAMS, type AffectParams } from './params';

/**
 * One affect engine for a conversation (P3-T09), fed from the machine's bus the way
 * `attachHistory` feeds the history: `[emote:x]` tags now, the user's fused affect from
 * P3-T07. Whoever attaches it owns the subscription — a page that attached twice would
 * feel every tag twice.
 *
 * **Read on demand, on the wall clock.** `state()` advances the engine to `now()` before
 * answering, so the stage's frame loop, the prompt and the voice all read the same state
 * at the moment they use it, and nothing needs a timer. The engine's fixed timestep makes
 * sixty reads a second cost the same as one (P3-T01).
 */
export interface AttachedAffect {
  readonly engine: AffectEngine;
  /** The state now. */
  state(): AffectState;
  /** The strongest feeling now, for `affectToBody`'s `feeling`. */
  feeling(): ReturnType<typeof dominantEmotion>;
  /** For `Reply`'s `voiceStyle`: how this sentence should sound, now. */
  readonly voiceStyle: (sentence: { readonly tags: readonly InlineTag[] }) => VoiceStyle;
  readonly detach: () => void;
}

export interface AttachAffectOptions {
  readonly characterId: string;
  /** Where to start: a restored state (P4), or the baseline now. */
  readonly state?: AffectState;
  readonly params?: AffectParams;
  /** Wall-clock ms. The bus stamps events with `Date.now()`, so this must agree with it. */
  readonly now?: () => number;
}

export function attachAffect(
  machine: { subscribe: (listener: (event: ConversationEvent) => void) => () => void },
  options: AttachAffectOptions,
): AttachedAffect {
  const params = options.params ?? DEFAULT_AFFECT_PARAMS;
  const now = options.now ?? Date.now;
  const engine = new AffectEngine(options.state ?? initialAffect(options.characterId, now(), params), params);
  const detach = machine.subscribe((event) => {
    for (const input of affectInputsFrom(event, params)) engine.enqueue(input);
  });
  const state = (): AffectState => engine.tick(now());
  return {
    engine,
    state,
    feeling: () => dominantEmotion(state(), params),
    voiceStyle: (sentence) => {
      const current = state();
      return affectToVoice(current, Date.parse(current.updatedAt), sentence.tags, undefined, params);
    },
    detach,
  };
}
