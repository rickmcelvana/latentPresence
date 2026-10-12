import { describe, expect, it } from 'vitest';
import {
  BOARD_TEXT,
  type BoardBox,
  type BoardFont,
  type MeasureText,
  layoutBoard,
  screenBlocks,
  whiteboardBlocks,
} from './displays';

/** Every character is 0.55 of the font size wide. */
const measure: MeasureText = (text: string, font: BoardFont) => [...text].length * font.sizePx * 0.55;

const BOX: BoardBox = { width: 1000, height: 700, padding: 20, pixelsPerMetre: 1000 };
/** Body text on this box: 32 px, 17.6 px per character, 43.2 px per line. */
const BODY_LINE = BOARD_TEXT.body * 1000 * BOARD_TEXT.lineHeight;

function texts(layout: ReturnType<typeof layoutBoard>): string[] {
  return layout.lines.map((line) => line.text);
}

describe('layoutBoard', () => {
  it('wraps words to the box width', () => {
    // 960 px of room, 17.6 px a character: 54 characters a line.
    const text = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november';
    const layout = layoutBoard([{ text, style: 'body' }], measure, BOX);
    expect(layout.lines.length).toBe(2);
    expect(texts(layout).join(' ')).toBe(text);
    for (const line of layout.lines) expect(measure(line.text, line.font)).toBeLessThanOrEqual(960);
    expect(layout.omitted).toBe(0);
  });

  it('positions lines down the box from the padding, one line height apart', () => {
    const layout = layoutBoard(
      [
        { text: 'one', style: 'body' },
        { text: 'two', style: 'body' },
      ],
      measure,
      BOX,
    );
    expect(layout.lines.map((line) => line.y)).toEqual([20, 20 + BODY_LINE]);
    expect(layout.lines.every((line) => line.x === 20)).toBe(true);
  });

  it('sizes text in board metres, through the texture\'s pixels per metre', () => {
    const layout = layoutBoard([{ text: 'title', style: 'title' }, { text: 'body', style: 'body' }], measure, { ...BOX, pixelsPerMetre: 2000 });
    expect(layout.lines[0]?.font.sizePx).toBeCloseTo(BOARD_TEXT.title * 2000);
    expect(layout.lines[1]?.font.sizePx).toBeCloseTo(BOARD_TEXT.body * 2000);
  });

  it('cuts a word longer than a line with an ellipsis', () => {
    const layout = layoutBoard([{ text: `see ${'x'.repeat(200)} here`, style: 'body' }], measure, BOX);
    const cut = layout.lines.find((line) => line.text.includes('…'));
    expect(cut).toBeDefined();
    expect(cut?.text.endsWith('…')).toBe(true);
    expect(measure(cut?.text ?? '', cut?.font ?? { sizePx: 1, bold: false })).toBeLessThanOrEqual(960);
    expect(texts(layout).join(' ')).toContain('here');
  });

  it('stops at the box height and ends with how many are left out', () => {
    const blocks = Array.from({ length: 40 }, (_, index) => ({ text: `task number ${index}`, style: 'body' as const }));
    const layout = layoutBoard(blocks, measure, BOX);
    const last = layout.lines.at(-1);
    expect(last?.text).toMatch(/^\+\d+ more$/u);
    const shown = layout.lines.length - 1;
    expect(last?.text).toBe(`+${40 - shown} more`);
    expect(layout.omitted).toBe(40 - shown);
    // Everything, the "+N more" line included, is inside the box.
    for (const line of layout.lines) expect(line.y + line.font.sizePx * BOARD_TEXT.lineHeight).toBeLessThanOrEqual(BOX.height - BOX.padding + 1e-6);
  });

  it('adds no "+N more" when everything fits', () => {
    const layout = layoutBoard([{ text: 'one line', style: 'body' }], measure, BOX);
    expect(texts(layout)).toEqual(['one line']);
    expect(layout.omitted).toBe(0);
  });

  it('shows what fits of a first block taller than the whole box', () => {
    const layout = layoutBoard([{ text: 'word '.repeat(2000), style: 'body' }], measure, BOX);
    expect(layout.lines.length).toBeGreaterThan(2);
    expect(layout.lines.at(-1)?.text).toBe('+1 more');
  });

  it('keeps a gap between blocks and ignores a trailing one', () => {
    const layout = layoutBoard([{ text: 'a', style: 'body' }, { text: '', style: 'gap' }, { text: 'b', style: 'body' }], measure, BOX);
    expect(layout.lines[1]?.y).toBeGreaterThan((layout.lines[0]?.y ?? 0) + BODY_LINE);
    const trailing = layoutBoard([{ text: 'a', style: 'body' }, { text: '', style: 'gap' }], measure, BOX);
    expect(texts(trailing)).toEqual(['a']);
  });
});

const task = (text: string, done = false) => ({ text, kind: 'task' as const, done });
const heading = (text: string) => ({ text, kind: 'heading' as const, done: false });

describe('whiteboardBlocks', () => {
  it('puts the title first, a heading per phase, and tasks ticked or not', () => {
    const blocks = whiteboardBlocks({ title: 'Garden', lines: [heading('Prepare'), task('Dig beds', true), task('Buy seed')] });
    expect(blocks).toEqual([
      { text: 'Garden', style: 'title' },
      { text: 'Prepare', style: 'heading' },
      { text: '☑ Dig beds', style: 'taskDone' },
      { text: '☐ Buy seed', style: 'task' },
    ]);
  });

  it('shows at most three phases and says how many it left out', () => {
    const lines = ['A', 'B', 'C', 'D', 'E'].flatMap((name) => [heading(name), task(`${name} task`)]);
    const blocks = whiteboardBlocks({ title: 'Many', lines });
    const headings = blocks.filter((block) => block.style === 'heading').map((block) => block.text);
    expect(headings).toEqual(['A', 'B', 'C']);
    expect(blocks.some((block) => block.text.startsWith('☐ D'))).toBe(false);
    expect(blocks.at(-1)).toEqual({ text: '+2 more phases', style: 'more' });
  });

  it('strikes through and mutes a done task', () => {
    const layout = layoutBoard(whiteboardBlocks({ title: 'T', lines: [heading('P'), task('done one', true), task('open one')] }), measure, BOX);
    const done = layout.lines.find((line) => line.text.includes('done one'));
    const open = layout.lines.find((line) => line.text.includes('open one'));
    expect(done).toMatchObject({ strike: true, colour: 'muted' });
    expect(open).toMatchObject({ strike: false, colour: 'ink' });
    expect(layout.lines[0]).toMatchObject({ colour: 'accent', text: 'T' });
  });
});

describe('screenBlocks', () => {
  const long = 'word '.repeat(100);

  it('shows the heading, then each source as a title, where and a line of text, with a gap between', () => {
    const blocks = screenBlocks({
      heading: 'Sources',
      items: [
        { title: 'Manual', where: 'p. 12', text: 'Hold the button.' },
        { title: 'Site', where: null, text: 'Other words.' },
      ],
    });
    expect(blocks).toEqual([
      { text: 'Sources', style: 'screenHeading' },
      { text: 'Manual', style: 'itemTitle' },
      { text: 'p. 12', style: 'where' },
      { text: 'Hold the button.', style: 'body' },
      { text: '', style: 'gap' },
      { text: 'Site', style: 'itemTitle' },
      { text: 'Other words.', style: 'body' },
    ]);
  });

  it('shows the first 140 characters of the text, cut with an ellipsis', () => {
    const blocks = screenBlocks({ heading: 'Sources', items: [{ title: 'T', where: null, text: long }] });
    const body = blocks.find((block) => block.style === 'body')?.text ?? '';
    expect(body.endsWith('…')).toBe(true);
    expect(body.length).toBeLessThanOrEqual(141);
    expect(body.length).toBeGreaterThan(100);
  });

  it('shows at most three sources', () => {
    const items = Array.from({ length: 5 }, (_, index) => ({ title: `S${index}`, where: null, text: 'x' }));
    const titles = screenBlocks({ heading: 'Sources', items }).filter((block) => block.style === 'itemTitle');
    expect(titles.map((block) => block.text)).toEqual(['S0', 'S1', 'S2']);
  });
});
