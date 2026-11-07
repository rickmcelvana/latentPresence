import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { screenBlocks, whiteboardBlocks } from '../stage/displays';
import { DisplayBoard, type BoardCanvas, drawPicture, hexColour, pictureKey } from './display-board';
import { STAGE_PALETTE, buildStage, stageBoards } from './stage';

interface Recorded {
  readonly fills: { readonly text: string; readonly colour: string }[];
  readonly rects: string[];
}

/** A canvas whose 2D context only records what is drawn; every character is half an em wide. */
function recordingCanvas(recorded: Recorded): (width: number, height: number) => BoardCanvas {
  return (width, height) => {
    let font = '';
    let fillStyle = '';
    const context = {
      set font(value: string) {
        font = value;
      },
      get font() {
        return font;
      },
      set fillStyle(value: string) {
        fillStyle = value;
      },
      get fillStyle() {
        return fillStyle;
      },
      textBaseline: 'top',
      textAlign: 'left',
      fillRect: (...args: number[]) => recorded.rects.push(`${fillStyle} ${args.join(',')}`),
      fillText: (text: string) => recorded.fills.push({ text, colour: fillStyle }),
      measureText: (text: string) => ({ width: text.length * (Number.parseFloat(font.replace(/^bold /u, '')) || 10) * 0.5 }),
    } as unknown as CanvasRenderingContext2D;
    return { width, height, getContext: () => context };
  };
}

function boardWith(recorded: Recorded): DisplayBoard {
  return new DisplayBoard({
    width: 1024,
    height: 756,
    pixelsPerMetre: 1219,
    padding: 36,
    palette: { background: STAGE_PALETTE.boardWhite, ink: STAGE_PALETTE.markerInk, accent: STAGE_PALETTE.markerAccent, muted: STAGE_PALETTE.markerMuted },
    idleBackground: STAGE_PALETTE.boardWhite,
    createCanvas: recordingCanvas(recorded),
  });
}

describe('DisplayBoard', () => {
  it('has an sRGB canvas texture with mipmaps, and starts blank', () => {
    const recorded: Recorded = { fills: [], rects: [] };
    const board = boardWith(recorded);
    expect(board.texture).toBeInstanceOf(THREE.CanvasTexture);
    expect(board.texture?.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(board.texture?.generateMipmaps).toBe(true);
    expect(recorded.fills).toEqual([]);
    expect(recorded.rects[0]).toBe(`${hexColour(STAGE_PALETTE.boardWhite)} 0,0,1024,756`);
  });

  it('draws the lines in palette colours, and redraws only when the content changes', () => {
    const recorded: Recorded = { fills: [], rects: [] };
    const board = boardWith(recorded);
    const blocks = whiteboardBlocks({ title: 'Garden', lines: [{ text: 'Prepare', kind: 'heading', done: false }, { text: 'Dig', kind: 'task', done: true }] });
    board.show(blocks);
    expect(recorded.fills.map((fill) => fill.text)).toEqual(['Garden', 'Prepare', '☑ Dig']);
    expect(recorded.fills.map((fill) => fill.colour)).toEqual([hexColour(STAGE_PALETTE.markerAccent), hexColour(STAGE_PALETTE.markerInk), hexColour(STAGE_PALETTE.markerMuted)]);
    const version = board.texture?.version ?? 0;
    board.show(blocks);
    expect(recorded.fills.length).toBe(3);
    expect(board.texture?.version).toBe(version);
    board.show(null);
    expect(recorded.fills.length).toBe(3);
    expect(board.texture?.version).toBeGreaterThan(version);
  });

  it('strikes through a done task', () => {
    const recorded: Recorded = { fills: [], rects: [] };
    boardWith(recorded).show(whiteboardBlocks({ title: 'T', lines: [{ text: 'Done', kind: 'task', done: true }] }));
    // The blank board, the redrawn background, then one thin bar under the done line.
    expect(recorded.rects.length).toBe(3);
  });
});

describe('stage boards with a canvas', () => {
  it('give the whiteboard its texture as the map and the screen its own', () => {
    const recorded: Recorded = { fills: [], rects: [] };
    const stage = buildStage(undefined, { createCanvas: recordingCanvas(recorded) });
    const boards = stageBoards(stage);
    const whiteboard = (stage.getObjectByName('whiteboard-surface') as THREE.Mesh).material as THREE.MeshStandardMaterial;
    const screen = (stage.getObjectByName('screen-surface') as THREE.Mesh).material as THREE.MeshBasicMaterial;
    expect(whiteboard.map).toBe(boards?.whiteboard.texture);
    expect(screen.map).toBe(boards?.screen.texture);
    expect(whiteboard.map).not.toBeNull();
    // The screen is off (its darker background) until it has something to show.
    expect(recorded.rects.at(-1)).toBe(`${hexColour(STAGE_PALETTE.screenOff)} 0,0,1024,610`);
    boards?.screen.show(screenBlocks({ heading: 'Sources', items: [{ title: 'Manual', where: 'p. 12', text: 'Hold the button.' }] }));
    expect(recorded.fills.map((fill) => fill.text)).toEqual(['Sources', 'Manual', 'p. 12', 'Hold the button.']);
  });
});

/** Records the calls that place a picture. */
function recorder(): { readonly calls: string[]; readonly ctx: CanvasRenderingContext2D } {
  const calls: string[] = [];
  const ctx = {
    globalAlpha: 1,
    fillStyle: '',
    save: () => calls.push('save'),
    restore: () => calls.push('restore'),
    translate: (x: number, y: number) => calls.push(`translate ${x},${y}`),
    rotate: (angle: number) => calls.push(`rotate ${angle.toFixed(4)}`),
    drawImage: (_source: unknown, ...args: number[]) => calls.push(`drawImage ${args.join(',')}`),
    fillRect: (...args: number[]) => calls.push(`fillRect ${args.join(',')}`),
  } as unknown as CanvasRenderingContext2D;
  return { calls, ctx };
}
const PICTURE = {} as CanvasImageSource;
const keyFor = (loaded: CanvasImageSource | null): string => JSON.stringify({ cards: [{ picture: { id: 'card-1', source: loaded } }] }, pictureKey);

describe("a plugin's pictures (P10-T05)", () => {

  it('draws a reversed card face up, turned 180° about its centre', () => {
    const { calls, ctx } = recorder();
    drawPicture(ctx, { picture: { id: 'card-1', source: PICTURE }, flip: true, x: 10, y: 20, width: 60, height: 100 }, '#888888');
    expect(calls).toEqual(['save', 'translate 40,70', `rotate ${Math.PI.toFixed(4)}`, 'drawImage -30,-50,60,100', 'restore']);
  });

  it('draws an upright card unturned, and a missing one as a faint space', () => {
    const upright = recorder();
    drawPicture(upright.ctx, { picture: { id: 'card-1', source: PICTURE }, flip: false, x: 10, y: 20, width: 60, height: 100 }, '#888888');
    expect(upright.calls.some((call) => call.startsWith('rotate'))).toBe(false);
    const missing = recorder();
    drawPicture(missing.ctx, { picture: { id: 'card-2', source: null }, flip: true, x: 10, y: 20, width: 60, height: 100 }, '#888888');
    expect(missing.calls).toEqual(['save', 'fillRect 10,20,60,100', 'restore']);
  });

  it('keys content by whether each picture has loaded, not by the image', () => {
    expect(keyFor(null)).toBe('{"cards":[{"picture":{"id":"card-1","source":false}}]}');
    expect(keyFor(PICTURE)).toBe('{"cards":[{"picture":{"id":"card-1","source":true}}]}');
  });
});
