import * as THREE from 'three';
import { type BoardBlock, type BoardBox, type BoardLayout, type ColourRole, fontCss, layoutBoard } from '../stage/displays';

/**
 * A board's texture: a canvas drawn with the system font and wrapped into a
 * `THREE.CanvasTexture` (P5-T08, ADR-49). Layout is `stage/displays.ts`'s pure function; this
 * file only draws it.
 *
 * In node there is no canvas, so a board made without one has no texture and draws nothing —
 * `buildStage` stays usable in the stage's node tests.
 */

/** The part of a canvas the board uses; `HTMLCanvasElement` and `OffscreenCanvas` both fit. */
export interface BoardCanvas {
  width: number;
  height: number;
  getContext(type: '2d'): CanvasRenderingContext2D | null;
}

export type CreateCanvas = (width: number, height: number) => BoardCanvas;

/** A board's colours, as palette numbers (`STAGE_PALETTE`'s). */
export interface BoardPalette {
  readonly background: number;
  readonly ink: number;
  readonly accent: number;
  readonly muted: number;
}

/** 0xrrggbb → `#rrggbb`. */
export function hexColour(value: number): string {
  return `#${value.toString(16).padStart(6, '0')}`;
}

/** Fills the background and draws the positioned lines — nothing downloaded, nothing else. */
export function drawBoard(ctx: CanvasRenderingContext2D, layout: BoardLayout | null, palette: BoardPalette, size: { readonly width: number; readonly height: number }): void {
  ctx.fillStyle = hexColour(palette.background);
  ctx.fillRect(0, 0, size.width, size.height);
  if (layout === null) return;
  const inks: Readonly<Record<ColourRole, string>> = { ink: hexColour(palette.ink), accent: hexColour(palette.accent), muted: hexColour(palette.muted) };
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  for (const line of layout.lines) {
    ctx.font = fontCss(line.font);
    ctx.fillStyle = inks[line.colour];
    ctx.fillText(line.text, line.x, line.y);
    if (line.strike) {
      const width = ctx.measureText(line.text).width;
      const middle = line.y + line.font.sizePx * 0.55;
      ctx.fillRect(line.x, middle, width, Math.max(1, line.font.sizePx * 0.06));
    }
  }
}

export interface DisplayBoardOptions {
  /** Texture size in pixels. */
  readonly width: number;
  readonly height: number;
  readonly pixelsPerMetre: number;
  readonly padding: number;
  /** The colours when there is content, and the background alone when there is none. */
  readonly palette: BoardPalette;
  readonly idleBackground: number;
  readonly createCanvas?: CreateCanvas | undefined;
}

export class DisplayBoard {
  /** Null when no canvas could be made (node): the surface then uses a plain material. */
  readonly texture: THREE.CanvasTexture | null;
  private readonly canvas: BoardCanvas | null;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly options: DisplayBoardOptions;
  private key: string | null = null;

  constructor(options: DisplayBoardOptions) {
    this.options = options;
    const canvas = options.createCanvas?.(options.width, options.height) ?? null;
    this.canvas = canvas;
    this.ctx = canvas?.getContext('2d') ?? null;
    if (canvas !== null && this.ctx !== null) {
      this.texture = new THREE.CanvasTexture(canvas as unknown as HTMLCanvasElement);
      this.texture.colorSpace = THREE.SRGBColorSpace;
      this.texture.generateMipmaps = true;
      this.texture.minFilter = THREE.LinearMipmapLinearFilter;
      this.show(null);
    } else {
      this.texture = null;
    }
  }

  setAnisotropy(level: number): void {
    if (this.texture === null) return;
    this.texture.anisotropy = Math.max(1, level);
    this.texture.needsUpdate = true;
  }

  /** The blocks drawn, or null for an empty board; redraws only when they changed. */
  show(blocks: readonly BoardBlock[] | null): void {
    const ctx = this.ctx;
    const canvas = this.canvas;
    if (ctx === null || canvas === null || this.texture === null) return;
    const key = JSON.stringify(blocks);
    if (key === this.key) return;
    this.key = key;
    const { width, height, padding, pixelsPerMetre, palette, idleBackground } = this.options;
    const box: BoardBox = { width, height, padding, pixelsPerMetre };
    if (blocks === null) {
      drawBoard(ctx, null, { ...palette, background: idleBackground }, box);
    } else {
      // Text is measured in the font it is drawn in, so wrapping matches the pixels.
      const layout = layoutBoard(
        blocks,
        (text, font) => {
          ctx.font = fontCss(font);
          return ctx.measureText(text).width;
        },
        box,
      );
      drawBoard(ctx, layout, palette, box);
    }
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.texture?.dispose();
  }
}
