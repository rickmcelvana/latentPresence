import type {
  AvatarCapabilities,
  AvatarRenderer,
  CharacterSource,
  ClipOptions,
  ExpressionWeights,
  GazeTarget,
  Viseme,
} from '@latentpresence/protocol';
import { VRM_VISEMES } from './visemes';

/** The mouth shapes, without silence: the ones that carry a weight. */
export type MouthShape = Exclude<Viseme, 'sil'>;

export const MOUTH_SHAPES: readonly MouthShape[] = VRM_VISEMES.filter(
  (viseme): viseme is MouthShape => viseme !== 'sil',
);

/**
 * The viseme channel's rule, shared by every renderer so they cannot disagree.
 *
 * Each mouth shape is its own channel and keeps its weight until set again, so a lip-sync
 * driver can blend — easing one vowel out while the next comes in, as Spike B's smoothing
 * does every frame. `sil` is the exception: it closes the mouth, every shape to zero,
 * whatever weight it is given, because "silence at 0.3" has no meaning a face can show.
 */
export function applyViseme(
  current: ReadonlyMap<MouthShape, number>,
  viseme: Viseme,
  weight: number,
): Map<MouthShape, number> {
  const next = new Map(current);
  if (viseme === 'sil') {
    for (const shape of MOUTH_SHAPES) next.set(shape, 0);
    return next;
  }
  next.set(viseme, Number.isFinite(weight) ? Math.min(1, Math.max(0, weight)) : 0);
  return next;
}

interface RunningClip {
  readonly id: string;
  readonly options: ClipOptions;
  elapsedMs: number;
  readonly resolve: () => void;
}

/**
 * An `AvatarRenderer` with no pixels: it keeps what it was told, so anything that drives
 * an avatar — the tag bridge (P2-T07), the affect mapping (P3-T04), the life layer — can
 * be tested against the interface rather than against WebGL.
 *
 * It follows the same rules the VRM renderer does, and `renderer-contract.test.ts` holds
 * both to them: nothing before `mount` and `loadCharacter`, an unknown clip rejects, a
 * looping clip resolves at once, and a one-shot resolves when it ends or is replaced.
 */
export class FakeAvatarRenderer implements AvatarRenderer {
  readonly id = 'fake';

  surface: unknown = null;
  character: CharacterSource | null = null;
  expression: ExpressionWeights = {};
  mouth: Map<MouthShape, number> = new Map(MOUTH_SHAPES.map((shape) => [shape, 0]));
  gaze: GazeTarget = 'user';
  /** Every clip started, in order, for assertions about what was asked for. */
  readonly clipsPlayed: { id: string; options: ClipOptions }[] = [];
  disposed = false;

  private readonly clipDurations: Map<string, number>;
  private running: RunningClip | null = null;

  /** @param clips Durations in ms of the clips this fake knows, by id. */
  constructor(clips: Readonly<Record<string, number>> = {}) {
    this.clipDurations = new Map(Object.entries(clips));
  }

  capabilities(): AvatarCapabilities {
    return { expressions: true, visemes: true, lookAt: true, clips: true, boneAccess: false };
  }

  mount(surface: unknown): Promise<void> {
    this.assertLive();
    this.surface = surface;
    return Promise.resolve();
  }

  loadCharacter(source: CharacterSource): Promise<void> {
    this.assertLive();
    if (this.surface === null) return Promise.reject(new Error('mount before loadCharacter'));
    this.character = source;
    return Promise.resolve();
  }

  setExpression(weights: ExpressionWeights): void {
    this.assertLoaded();
    this.expression = { ...weights };
  }

  setViseme(viseme: Viseme, weight: number): void {
    this.assertLoaded();
    this.mouth = applyViseme(this.mouth, viseme, weight);
  }

  setGaze(target: GazeTarget): void {
    this.assertLoaded();
    this.gaze = target;
  }

  playClip(clipId: string, options: ClipOptions): Promise<void> {
    this.assertLoaded();
    const duration = this.clipDurations.get(clipId);
    if (duration === undefined) return Promise.reject(new Error(`unknown clip "${clipId}"`));
    this.clipsPlayed.push({ id: clipId, options });

    // Whatever was playing is replaced, which is its end as far as its caller knows.
    this.running?.resolve();
    this.running = null;

    if (options.loop) return Promise.resolve();
    return new Promise((resolve) => {
      this.running = { id: clipId, options, elapsedMs: 0, resolve };
    });
  }

  /** The one-shot clip still running, if any. */
  get currentClip(): string | null {
    return this.running?.id ?? null;
  }

  update(deltaMs: number): void {
    const running = this.running;
    if (running === null) return;
    running.elapsedMs += deltaMs;
    if (running.elapsedMs >= (this.clipDurations.get(running.id) ?? 0)) {
      this.running = null;
      running.resolve();
    }
  }

  dispose(): void {
    this.running?.resolve();
    this.running = null;
    this.disposed = true;
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('renderer is disposed');
  }

  private assertLoaded(): void {
    this.assertLive();
    if (this.character === null) throw new Error('no character loaded');
  }
}
