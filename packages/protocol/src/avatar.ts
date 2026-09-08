import { z } from 'zod';
import type { ExpressionWeights, GazeTarget } from './affect';
import type { AvatarCapabilities } from './capabilities';
import { DurationMsSchema, IdSchema, UnitIntervalSchema } from './common';

/** The mouth shapes lip sync drives. The VRM 1.0 set, plus silence. */
export const VisemeSchema = z.enum(['aa', 'ih', 'ou', 'ee', 'oh', 'sil']);
export type Viseme = z.infer<typeof VisemeSchema>;

/**
 * A character the renderer can load. The licence travels with the asset because we
 * ship nothing we cannot redistribute, and the model registry has to show it.
 */
export const CharacterSourceSchema = z.object({
  id: IdSchema,
  url: z.string().min(1),
  format: z.literal('vrm'),
  licence: z.string().min(1),
  attribution: z.string().nullable(),
});
export type CharacterSource = z.infer<typeof CharacterSourceSchema>;

export const ClipOptionsSchema = z.object({
  loop: z.boolean(),
  /** State changes crossfade rather than snap; P2-T03 holds this under 300 ms. */
  crossfadeMs: DurationMsSchema,
  weight: UnitIntervalSchema,
});
export type ClipOptions = z.infer<typeof ClipOptionsSchema>;

/**
 * The avatar behind a plugin boundary (ADR-03), so a VRM renderer, a 2D fallback or a
 * future Audio2Face path are swappable.
 *
 * Generic over its surface because `packages/protocol` has no DOM lib: the VRM
 * implementation instantiates it with `HTMLCanvasElement`, and this package never
 * learns what a canvas is.
 */
export interface AvatarRenderer<TSurface = unknown> {
  readonly id: string;
  capabilities(): AvatarCapabilities;

  mount(surface: TSurface): Promise<void>;
  loadCharacter(source: CharacterSource): Promise<void>;

  setExpression(weights: ExpressionWeights): void;
  setViseme(viseme: Viseme, weight: number): void;
  setGaze(target: GazeTarget): void;

  /** Resolves when the clip finishes, or immediately for a looping one. */
  playClip(clipId: string, options: ClipOptions): Promise<void>;

  /** Driven by the render loop, not by a timer inside the renderer. */
  update(deltaMs: number): void;
  dispose(): void;
}
