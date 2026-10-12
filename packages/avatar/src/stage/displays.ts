/**
 * The room's two diegetic displays (P5-T08, ADR-49): what the whiteboard and the screen show,
 * and the layout that turns it into positioned lines of text.
 *
 * Three-free and canvas-free, like `camera.ts`: content in, positioned lines out, with the
 * text measure injected so wrapping is tested in node with a fake. Only `vrm/display-board.ts`
 * touches a canvas.
 */

/** A plan on the whiteboard: a title, then phases (headings) and their tasks, in order. */
export interface WhiteboardContent {
  readonly title: string;
  /** In order: a phase is a heading; a task has done true/false. */
  readonly lines: readonly { readonly text: string; readonly kind: 'heading' | 'task'; readonly done: boolean }[];
}

/** The sources of her latest answer, on the screen. */
export interface ScreenContent {
  readonly heading: string; // e.g. "Sources"
  readonly items: readonly { readonly title: string; readonly where: string | null; readonly text: string }[];
}

export interface Displays {
  readonly whiteboard: WhiteboardContent | null;
  readonly screen: ScreenContent | null;
}

/**
 * Text sizes in **board metres** (the height of an em on the board), converted to texture
 * pixels by the texture's pixels per metre. 3.2 cm body text projects to about 16 px at the
 * `medium` preset on a 1080p frame — the readability bar of ADR-49, proved in `stage.test.ts`.
 */
export const BOARD_TEXT = {
  body: 0.032,
  title: 0.05,
  heading: 0.04,
  small: 0.028,
  /** A line is this many times its text size tall. */
  lineHeight: 1.35,
} as const;

/** The most phases the whiteboard shows, and sources the screen shows. */
export const MAX_BOARD_PHASES = 3;
export const MAX_SCREEN_ITEMS = 3;
/** How much of a source's text the screen shows. */
export const SCREEN_TEXT_CHARS = 140;

export type BoardStyle = 'title' | 'heading' | 'task' | 'taskDone' | 'screenHeading' | 'itemTitle' | 'where' | 'body' | 'more' | 'gap';

/** Which of the palette's inks a line is drawn in; `drawBoard` maps these to colours. */
export type ColourRole = 'ink' | 'accent' | 'muted';

interface StyleSpec {
  readonly size: number;
  readonly bold: boolean;
  readonly colour: ColourRole;
  /** Left indent, in board metres. */
  readonly indent: number;
  readonly strike: boolean;
}

const STYLES: Readonly<Record<BoardStyle, StyleSpec>> = {
  title: { size: BOARD_TEXT.title, bold: true, colour: 'accent', indent: 0, strike: false },
  heading: { size: BOARD_TEXT.heading, bold: true, colour: 'ink', indent: 0, strike: false },
  task: { size: BOARD_TEXT.body, bold: false, colour: 'ink', indent: 0.012, strike: false },
  taskDone: { size: BOARD_TEXT.body, bold: false, colour: 'muted', indent: 0.012, strike: true },
  screenHeading: { size: BOARD_TEXT.title, bold: true, colour: 'accent', indent: 0, strike: false },
  itemTitle: { size: BOARD_TEXT.body, bold: true, colour: 'ink', indent: 0, strike: false },
  where: { size: BOARD_TEXT.small, bold: false, colour: 'muted', indent: 0, strike: false },
  body: { size: BOARD_TEXT.body, bold: false, colour: 'ink', indent: 0, strike: false },
  more: { size: BOARD_TEXT.small, bold: false, colour: 'muted', indent: 0, strike: false },
  gap: { size: BOARD_TEXT.body, bold: false, colour: 'ink', indent: 0, strike: false },
};

/** A gap is this fraction of a body line. */
const GAP_LINES = 0.6;

/** One run of text in a style; wrapped into as many lines as the width needs. */
export interface BoardBlock {
  readonly text: string;
  readonly style: BoardStyle;
}

/** A font in texture pixels. */
export interface BoardFont {
  readonly sizePx: number;
  readonly bold: boolean;
}

/** The CSS font shorthand for a font — the system's own, nothing downloaded. */
export function fontCss(font: BoardFont): string {
  return `${font.bold ? 'bold ' : ''}${Math.round(font.sizePx)}px system-ui, sans-serif`;
}

/** The width of `text` in `font`, in pixels. A canvas context's `measureText` is the real one. */
export type MeasureText = (text: string, font: BoardFont) => number;

/** The drawable area of a board texture, in pixels. */
export interface BoardBox {
  readonly width: number;
  readonly height: number;
  /** Empty space kept all round. */
  readonly padding: number;
  readonly pixelsPerMetre: number;
}

export interface PositionedLine {
  readonly text: string;
  readonly font: BoardFont;
  readonly colour: ColourRole;
  readonly strike: boolean;
  /** Left edge and top of the line box, in pixels from the texture's top left. */
  readonly x: number;
  readonly y: number;
}

export interface BoardLayout {
  readonly lines: readonly PositionedLine[];
  /** Blocks (tasks, sources...) that did not fit; the layout ends with a "+N more" line when above 0. */
  readonly omitted: number;
}

const ELLIPSIS = '…';

/** The longest prefix of `word` that, with an ellipsis, fits `width`; the ellipsis alone at worst. */
function cutWord(word: string, font: BoardFont, measure: MeasureText, width: number): string {
  const chars = [...word];
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (measure(chars.slice(0, mid).join('') + ELLIPSIS, font) <= width) low = mid;
    else high = mid - 1;
  }
  return chars.slice(0, low).join('') + ELLIPSIS;
}

/** Words wrapped to `width`; a word longer than a line is cut with an ellipsis. */
function wrap(text: string, font: BoardFont, measure: MeasureText, width: number): string[] {
  const words = text.split(/\s+/u).filter((word) => word !== '');
  const lines: string[] = [];
  let line = '';
  for (const raw of words) {
    const word = measure(raw, font) > width ? cutWord(raw, font, measure, width) : raw;
    const attempt = line === '' ? word : `${line} ${word}`;
    if (line === '' || measure(attempt, font) <= width) {
      line = attempt;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== '') lines.push(line);
  return lines;
}

interface Group {
  readonly spec: StyleSpec;
  readonly font: BoardFont;
  readonly lineHeight: number;
  readonly indent: number;
  readonly lines: readonly string[];
  readonly height: number;
  readonly gap: boolean;
}

/**
 * Lays blocks out top to bottom in `box`: words wrapped to the width with the injected
 * `measure`, a word longer than a line cut with an ellipsis, and — when the blocks are
 * taller than the box — as many whole blocks as fit followed by a "+N more" line.
 */
export function layoutBoard(blocks: readonly BoardBlock[], measure: MeasureText, box: BoardBox): BoardLayout {
  const inner = box.height - 2 * box.padding;
  const groups: Group[] = blocks.map((block) => {
    const spec = STYLES[block.style];
    const font: BoardFont = { sizePx: spec.size * box.pixelsPerMetre, bold: spec.bold };
    const lineHeight = font.sizePx * BOARD_TEXT.lineHeight;
    const indent = spec.indent * box.pixelsPerMetre;
    if (block.style === 'gap') {
      return { spec, font, lineHeight, indent, lines: [], height: BOARD_TEXT.body * box.pixelsPerMetre * BOARD_TEXT.lineHeight * GAP_LINES, gap: true };
    }
    const lines = wrap(block.text, font, measure, box.width - 2 * box.padding - indent);
    return { spec, font, lineHeight, indent, lines, height: lines.length * lineHeight, gap: false };
  });

  const moreSpec = STYLES.more;
  const moreFont: BoardFont = { sizePx: moreSpec.size * box.pixelsPerMetre, bold: false };
  const moreHeight = moreFont.sizePx * BOARD_TEXT.lineHeight;
  const countReal = (from: number): number => groups.slice(from).filter((group) => !group.gap && group.lines.length > 0).length;

  // The most whole groups that fit; if some are left over, the "+N more" line must fit too.
  let shown = 0;
  let used = 0;
  while (shown < groups.length && used + (groups[shown]?.height ?? 0) <= inner) {
    used += groups[shown]?.height ?? 0;
    shown += 1;
  }
  if (shown < groups.length) {
    while (shown > 0 && used + moreHeight > inner) {
      shown -= 1;
      used -= groups[shown]?.height ?? 0;
    }
  }
  // A trailing gap is only space.
  while (shown > 0 && groups[shown - 1]?.gap === true) {
    shown -= 1;
    used -= groups[shown]?.height ?? 0;
  }

  const lines: PositionedLine[] = [];
  let y = box.padding;
  const place = (group: Group, count: number): void => {
    for (const text of group.lines.slice(0, count)) {
      lines.push({ text, font: group.font, colour: group.spec.colour, strike: group.spec.strike, x: box.padding + group.indent, y });
      y += group.lineHeight;
    }
  };

  let omitted = countReal(shown);
  for (const group of groups.slice(0, shown)) {
    if (group.gap) y += group.height;
    else place(group, group.lines.length);
  }

  // The very first block alone is taller than the board: show what fits of it.
  const first = groups[0];
  if (shown === 0 && first !== undefined && !first.gap) {
    const room = Math.max(0, Math.floor((inner - moreHeight) / first.lineHeight));
    place(first, room);
    omitted = countReal(0) - (room >= first.lines.length ? 1 : 0);
  }

  if (omitted > 0 && y + moreHeight <= box.height - box.padding + 1e-6) {
    lines.push({ text: `+${omitted} more`, font: moreFont, colour: moreSpec.colour, strike: false, x: box.padding, y });
  }
  return { lines, omitted };
}

/** The text cut to `max` characters on a word edge where it can, with an ellipsis. */
function clip(text: string, max: number): string {
  const flat = text.replaceAll(/\s+/gu, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}${ELLIPSIS}`;
}

/** The whiteboard's blocks: the title, then at most three phases, each a heading and its tasks. */
export function whiteboardBlocks(content: WhiteboardContent): BoardBlock[] {
  const blocks: BoardBlock[] = [{ text: content.title, style: 'title' }];
  let phases = 0;
  let hidden = 0;
  for (const line of content.lines) {
    if (line.kind === 'heading') {
      phases += 1;
      if (phases > MAX_BOARD_PHASES) {
        hidden += 1;
        continue;
      }
      blocks.push({ text: line.text, style: 'heading' });
    } else if (phases <= MAX_BOARD_PHASES) {
      blocks.push({ text: `${line.done ? '☑' : '☐'} ${line.text}`, style: line.done ? 'taskDone' : 'task' });
    }
  }
  if (hidden > 0) blocks.push({ text: `+${hidden} more ${hidden === 1 ? 'phase' : 'phases'}`, style: 'more' });
  return blocks;
}

/** The screen's blocks: the heading, then at most three sources — title, where, a line of text. */
export function screenBlocks(content: ScreenContent): BoardBlock[] {
  const blocks: BoardBlock[] = [{ text: content.heading, style: 'screenHeading' }];
  content.items.slice(0, MAX_SCREEN_ITEMS).forEach((item, index) => {
    if (index > 0) blocks.push({ text: '', style: 'gap' });
    blocks.push({ text: item.title, style: 'itemTitle' });
    if (item.where !== null && item.where.trim() !== '') blocks.push({ text: item.where, style: 'where' });
    const text = clip(item.text, SCREEN_TEXT_CHARS);
    if (text !== '') blocks.push({ text, style: 'body' });
  });
  return blocks;
}
