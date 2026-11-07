import { BOARD_TEXT, type BoardBlock, type BoardBox, type BoardFont, type BoardLayout, type MeasureText, type PositionedLine, wrapText } from './displays';

/**
 * A plugin's layouts on the room's boards (P10-T05, ADR-72 item 6): `cards`, a title and up to ten
 * pictures each with a caption, and `list`, a title and lines. Pure like `displays.ts`: content in,
 * positioned lines and pictures out, the text measure injected. Captions are body text, so ADR-49's
 * 16 px bar holds for them as for the plan and the sources.
 */

/** A picture the app decoded from a plugin's pinned asset; `source` is null until it has loaded (or if it failed). */
export interface BoardPicture {
  readonly id: string;
  readonly source: CanvasImageSource | null;
}

export interface BoardCard {
  readonly caption: string;
  readonly picture: BoardPicture | null;
  /** Rotated 180°, still face up: a reversed card. */
  readonly flip: boolean;
}

export interface CardsContent {
  readonly layout: 'cards';
  readonly title: string | null;
  readonly cards: readonly BoardCard[];
  /** Width over height of the pictures (a tarot card is about 0.6). */
  readonly aspect: number;
  /** The number of the first card here, for the numbered layout: a spread that spans both boards continues its count. */
  readonly firstNumber: number;
}

export interface ListContent {
  readonly layout: 'list';
  readonly title: string | null;
  readonly lines: readonly string[];
}

export type PluginBoardContent = CardsContent | ListContent;

/** What a plugin put on each board; a board with null shows its own content (the plan, the sources). */
export interface PluginWall {
  readonly whiteboard: PluginBoardContent | null;
  readonly screen: PluginBoardContent | null;
}

/** The most cards a layout shows (ADR-72 item 6). */
export const MAX_BOARD_CARDS = 10;
/** More than this many cards spans both boards, left to right: the whiteboard first, then the screen. */
export const CARDS_PER_BOARD = 5;
/** The most lines a caption under a card takes; a longer one, or a word wider than the card, numbers the cards instead. */
export const MAX_CAPTION_LINES = 3;
/** Board metres between cards, and between a card and its caption. */
const CARD_GAP = 0.012;
const CAPTION_GAP = 0.006;
/** Under this height (board metres) captions under the cards give way to the numbered layout. */
const MIN_CARD_HEIGHT = 0.12;
/** Captions under the cards are kept while their cards are at least this share of the numbered layout's (seen at 1080p: two rows of small cards read worse than one row of numbered ones). */
const CAPTIONS_KEEP = 0.8;
/** A picture's aspect when none has loaded yet: a playing card's. */
export const DEFAULT_CARD_ASPECT = 2 / 3;

export interface PlacedPicture {
  readonly picture: BoardPicture | null;
  readonly flip: boolean;
  /** In texture pixels from the top left. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A patch of the board's own colour under a card's number, so the number reads on any picture. */
export interface Badge {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface CardsLayout extends BoardLayout {
  readonly pictures: readonly PlacedPicture[];
  /** Drawn over the pictures, under the text. */
  readonly badges: readonly Badge[];
  /** `captions`: each caption under its card. `numbered`: a number on each card, the captions listed below. */
  readonly mode: 'captions' | 'numbered';
}

/** A plugin's layout on the boards: on its own board, or — cards past five — across both, left to right. */
export function placeOnWall(content: PluginBoardContent, where: 'whiteboard' | 'screen'): PluginWall {
  if (content.layout === 'cards' && Math.min(content.cards.length, MAX_BOARD_CARDS) > CARDS_PER_BOARD) {
    const cards = content.cards.slice(0, MAX_BOARD_CARDS);
    const left = Math.ceil(cards.length / 2);
    return {
      whiteboard: { ...content, cards: cards.slice(0, left), firstNumber: content.firstNumber },
      screen: { ...content, title: null, cards: cards.slice(left), firstNumber: content.firstNumber + left },
    };
  }
  return where === 'whiteboard' ? { whiteboard: content, screen: null } : { whiteboard: null, screen: content };
}

/** A list's blocks: its title, then a line each (the board's "+N more" takes what does not fit). */
export function listBlocks(content: ListContent): BoardBlock[] {
  return [...(content.title === null ? [] : [{ text: content.title, style: 'title' as const }]), ...content.lines.map((text) => ({ text, style: 'body' as const }))];
}

interface Plan {
  readonly mode: CardsLayout['mode'];
  readonly rows: number;
  readonly columns: number;
  readonly cell: number;
  readonly pictureHeight: number;
  /** Under each card: its caption's lines (`captions`), or nothing (`numbered`, the number is on the card). */
  readonly captions: readonly (readonly string[])[];
  readonly rowCaptionLines: readonly number[];
  readonly legend: readonly string[];
}

/**
 * Lays cards out on one board: the title, then the cards in the rows that make them largest, each
 * with its caption under it — or, when a caption would need more than three lines or a word is wider
 * than its card, or the cards would be under 12 cm tall or much smaller than numbered ones, a number on each card's corner and the
 * captions listed below in full. Nothing is cut that a person would need to read.
 */
export function layoutCards(content: CardsContent, measure: MeasureText, box: BoardBox): CardsLayout {
  const ppm = box.pixelsPerMetre;
  const body: BoardFont = { sizePx: BOARD_TEXT.body * ppm, bold: false };
  const titleFont: BoardFont = { sizePx: BOARD_TEXT.title * ppm, bold: true };
  const lineHeight = body.sizePx * BOARD_TEXT.lineHeight;
  const width = box.width - 2 * box.padding;
  const gap = CARD_GAP * ppm;
  const captionGap = CAPTION_GAP * ppm;
  const lines: PositionedLine[] = [];
  const badges: Badge[] = [];
  const pictures: PlacedPicture[] = [];

  let top = box.padding;
  if (content.title !== null && content.title.trim() !== '') {
    const [first] = wrapText(content.title, titleFont, measure, width);
    if (first !== undefined) {
      lines.push({ text: first, font: titleFont, colour: 'accent', strike: false, x: box.padding, y: top });
      top += titleFont.sizePx * BOARD_TEXT.lineHeight;
    }
  }
  const cards = content.cards.slice(0, MAX_BOARD_CARDS);
  const omitted = content.cards.length - cards.length;
  const moreHeight = omitted > 0 ? BOARD_TEXT.small * ppm * BOARD_TEXT.lineHeight : 0;
  const room = box.height - box.padding - top - moreHeight;
  const aspect = content.aspect > 0 ? content.aspect : DEFAULT_CARD_ASPECT;
  const textBelow = (plan: Pick<Plan, 'rowCaptionLines' | 'legend'>): number =>
    plan.rowCaptionLines.reduce((sum, count) => sum + (count > 0 ? count * lineHeight + captionGap : 0), 0) + (plan.legend.length > 0 ? gap + plan.legend.length * lineHeight : 0);

  const planFor = (mode: CardsLayout['mode'], rows: number): Plan | null => {
    const columns = Math.ceil(cards.length / rows);
    const cell = (width - (columns - 1) * gap) / columns;
    let captions: string[][] = cards.map(() => []);
    let legend: string[] = [];
    if (mode === 'captions') {
      if (cards.some((card) => card.caption.split(/\s+/u).some((word) => word !== '' && measure(word, body) > cell))) return null;
      captions = cards.map((card) => wrapText(card.caption, body, measure, cell));
      if (captions.some((caption) => caption.length > MAX_CAPTION_LINES)) return null;
    } else {
      legend = cards.flatMap((card, index) => wrapText(`${content.firstNumber + index}. ${card.caption}`, body, measure, width));
    }
    const rowCaptionLines = Array.from({ length: rows }, (_, row) => Math.max(0, ...captions.slice(row * columns, (row + 1) * columns).map((caption) => caption.length)));
    const pictureHeight = Math.min(cell / aspect, (room - textBelow({ rowCaptionLines, legend }) - (rows - 1) * gap) / rows);
    return pictureHeight > 0 ? { mode, rows, columns, cell, pictureHeight, captions, rowCaptionLines, legend } : null;
  };

  const best = (mode: CardsLayout['mode']): Plan | null => {
    let chosen: Plan | null = null;
    for (let rows = 1; rows <= cards.length; rows += 1) {
      const plan = planFor(mode, rows);
      if (plan !== null && (chosen === null || plan.pictureHeight > chosen.pictureHeight + 1e-6)) chosen = plan;
    }
    return chosen;
  };

  if (cards.length === 0) return { lines, pictures, badges, omitted, mode: 'captions' };
  // Captions under the cards read best, unless they shrink the cards: then number them and list the captions.
  const underCaptions = best('captions');
  const numbered = best('numbered');
  const keepCaptions = underCaptions !== null && underCaptions.pictureHeight >= Math.max(MIN_CARD_HEIGHT * ppm, CAPTIONS_KEEP * (numbered?.pictureHeight ?? 0));
  const plan = keepCaptions ? underCaptions : (numbered ?? underCaptions);
  if (plan === null) return { lines, pictures, badges, omitted: omitted + cards.length, mode: 'numbered' };

  const pictureWidth = plan.pictureHeight * aspect;
  const used = plan.rows * plan.pictureHeight + (plan.rows - 1) * gap + textBelow(plan);
  let y = top + Math.max(0, (room - used) / 2);
  for (let row = 0; row < plan.rows; row += 1) {
    const inRow = cards.slice(row * plan.columns, (row + 1) * plan.columns);
    // A short last row is centred under the full ones.
    const rowWidth = inRow.length * plan.cell + (inRow.length - 1) * gap;
    const left = box.padding + (width - rowWidth) / 2;
    inRow.forEach((card, column) => {
      const index = row * plan.columns + column;
      const centre = left + column * (plan.cell + gap) + plan.cell / 2;
      const x = centre - pictureWidth / 2;
      pictures.push({ picture: card.picture, flip: card.flip, x, y, width: pictureWidth, height: plan.pictureHeight });
      if (plan.mode === 'numbered') {
        // The number on the card's top left, on a patch of the board's own colour so it reads on any picture.
        const text = String(content.firstNumber + index);
        const inset = captionGap;
        const badge = { x: x + inset, y: y + inset, width: measure(text, body) + 2 * inset, height: lineHeight };
        badges.push(badge);
        lines.push({ text, font: body, colour: 'ink', strike: false, x: badge.x + inset, y: badge.y + (lineHeight - body.sizePx) / 2 });
      }
      (plan.captions[index] ?? []).forEach((text, line) => {
        lines.push({ text, font: body, colour: 'ink', strike: false, x: centre - measure(text, body) / 2, y: y + plan.pictureHeight + captionGap + line * lineHeight });
      });
    });
    const below = plan.rowCaptionLines[row] ?? 0;
    y += plan.pictureHeight + (below > 0 ? captionGap + below * lineHeight : 0) + gap;
  }
  for (const text of plan.legend) {
    lines.push({ text, font: body, colour: 'ink', strike: false, x: box.padding, y });
    y += lineHeight;
  }
  if (omitted > 0) {
    lines.push({ text: `+${omitted} more`, font: { sizePx: BOARD_TEXT.small * ppm, bold: false }, colour: 'muted', strike: false, x: box.padding, y: box.height - box.padding - moreHeight });
  }
  return { lines, pictures, badges, omitted, mode: plan.mode };
}
