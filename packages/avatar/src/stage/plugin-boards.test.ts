import { describe, expect, it } from 'vitest';
import { BOARD_TEXT, type BoardBox, type BoardFont, type MeasureText } from './displays';
import { CARDS_PER_BOARD, type BoardCard, type CardsContent, type CardsLayout, layoutCards, listBlocks, placeOnWall } from './plugin-boards';

/** Every character is 0.55 of the font size wide (as in `displays.test.ts`). */
const measure: MeasureText = (text: string, font: BoardFont) => [...text].length * font.sizePx * 0.55;

/** The screen's texture: 0.84 × 0.50 m at 1024 px across (`boardTextureBox(SCREEN)`). */
const PPM = 1024 / 0.84;
const SCREEN_BOX: BoardBox = { width: 1024, height: Math.round(0.5 * PPM), padding: 0.03 * PPM, pixelsPerMetre: PPM };
const WHITEBOARD_BOX: BoardBox = { width: 1024, height: Math.round(0.62 * PPM), padding: 0.03 * PPM, pixelsPerMetre: PPM };

const CELTIC = ['The present', 'What crosses it', 'What crowns it', 'What lies beneath', 'What is behind', 'What lies ahead', 'Yourself', 'Your surroundings', 'Hopes and fears', 'The outcome'];
const NAMES = ['The Tower', 'Queen of Pentacles', 'The Hierophant', 'Ten of Swords', 'Wheel of Fortune', 'Page of Cups', 'The Moon', 'Knight of Wands', 'Two of Cups', 'The World'];

function cards(slots: readonly string[], reversed: readonly number[] = []): BoardCard[] {
  return slots.map((slot, index) => ({ caption: `${slot}: ${NAMES[index] ?? 'The Fool'}`, picture: { id: `card-${index + 1}`, source: null }, flip: reversed.includes(index) }));
}

function content(list: readonly BoardCard[], title: string | null = 'A reading'): CardsContent {
  return { layout: 'cards', title, cards: list, aspect: 250 / 419, firstNumber: 1 };
}

function overlaps(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** What every cards layout must keep: inside the board, nothing cut, body-sized text, pictures apart and clear of the text. */
function expectSound(layout: CardsLayout, box: BoardBox, given: CardsContent): void {
  for (const line of layout.lines) {
    if (!line.text.startsWith('+')) expect(line.font.sizePx).toBeGreaterThanOrEqual(BOARD_TEXT.body * box.pixelsPerMetre - 1e-9);
    expect(line.text).not.toContain('…');
    expect(line.x).toBeGreaterThanOrEqual(box.padding - 1e-6);
    expect(line.x + measure(line.text, line.font)).toBeLessThanOrEqual(box.width - box.padding + 1e-6);
    expect(line.y + line.font.sizePx * BOARD_TEXT.lineHeight).toBeLessThanOrEqual(box.height - box.padding + 1e-6);
  }
  layout.pictures.forEach((placed, index) => {
    expect(placed.x).toBeGreaterThanOrEqual(box.padding - 1e-6);
    expect(placed.x + placed.width).toBeLessThanOrEqual(box.width - box.padding + 1e-6);
    expect(placed.y + placed.height).toBeLessThanOrEqual(box.height - box.padding + 1e-6);
    expect(placed.width / placed.height).toBeCloseTo(given.aspect, 6);
    for (const other of layout.pictures.slice(index + 1)) expect(overlaps(placed, other)).toBe(false);
    // Only a card's own number sits on it, on its badge.
    for (const line of layout.lines) {
      const rect = { x: line.x, y: line.y, width: measure(line.text, line.font), height: line.font.sizePx };
      if (overlaps(placed, rect)) expect(layout.badges.some((badge) => rect.x >= badge.x && rect.x + rect.width <= badge.x + badge.width && rect.y >= badge.y && rect.y + rect.height <= badge.y + badge.height + 1e-6)).toBe(true);
    }
  });
  // Every caption can be read in full: under its card, or in the numbered list.
  const text = layout.lines.map((line) => line.text).join(' ');
  for (const card of given.cards.slice(0, 10)) expect(text.replaceAll(/\s+/gu, ' ')).toContain(card.caption);
}

describe('placeOnWall (P10-T05)', () => {
  it('keeps up to five cards on the board the plugin named', () => {
    const three = content(cards(['Past', 'Present', 'Future']));
    expect(placeOnWall(three, 'screen')).toEqual({ whiteboard: null, screen: three });
    expect(placeOnWall(three, 'whiteboard')).toEqual({ whiteboard: three, screen: null });
  });

  it('spans more than five across both boards, left to right, the count carried on', () => {
    const wall = placeOnWall(content(cards(CELTIC), 'The Celtic cross'), 'screen');
    expect(wall.whiteboard).toMatchObject({ title: 'The Celtic cross', firstNumber: 1 });
    expect(wall.screen).toMatchObject({ title: null, firstNumber: 6 });
    expect(wall.whiteboard?.layout === 'cards' && wall.whiteboard.cards.map((card) => card.caption)).toEqual(cards(CELTIC).slice(0, 5).map((card) => card.caption));
    expect(wall.screen?.layout === 'cards' && wall.screen.cards.length).toBe(5);
    const seven = placeOnWall(content(cards(CELTIC.slice(0, 7))), 'whiteboard');
    expect([seven.whiteboard?.layout === 'cards' && seven.whiteboard.cards.length, seven.screen?.layout === 'cards' && seven.screen.cards.length]).toEqual([4, 3]);
    expect(CARDS_PER_BOARD).toBe(5);
  });

  it('puts a list on its own board', () => {
    const list = { layout: 'list' as const, title: 'Rolls', lines: ['2d6: 7'] };
    expect(placeOnWall(list, 'whiteboard')).toEqual({ whiteboard: list, screen: null });
    expect(listBlocks(list)).toEqual([
      { text: 'Rolls', style: 'title' },
      { text: '2d6: 7', style: 'body' },
    ]);
    expect(listBlocks({ ...list, title: null })).toEqual([{ text: '2d6: 7', style: 'body' }]);
  });
});

describe('layoutCards (P10-T05)', () => {
  it('lays three cards in a row on the screen, each caption under its card', () => {
    const given = content(cards(['Past', 'Present', 'Future'], [1]), 'Past, present and future');
    const layout = layoutCards(given, measure, SCREEN_BOX);
    expect(layout.mode).toBe('captions');
    expect(layout.badges).toEqual([]);
    expect(layout.pictures).toHaveLength(3);
    expect(new Set(layout.pictures.map((placed) => Math.round(placed.y))).size).toBe(1);
    expect(layout.pictures.map((placed) => placed.flip)).toEqual([false, true, false]);
    expect(layout.lines[0]).toMatchObject({ text: 'Past, present and future', colour: 'accent' });
    // Big enough to see the picture: over 20 cm tall on a 50 cm screen.
    expect(layout.pictures[0]!.height / PPM).toBeGreaterThan(0.2);
    expectSound(layout, SCREEN_BOX, given);
  });

  it.each([
    ['the whiteboard', WHITEBOARD_BOX, 0, 'The Celtic cross'],
    ['the screen', SCREEN_BOX, 5, null],
  ] as const)('lays five of a ten-card spread on %s, numbered in one row, nothing cut', (_name, box, from, title) => {
    const given: CardsContent = { ...content(cards(CELTIC).slice(from, from + 5), title), firstNumber: from + 1 };
    const layout = layoutCards(given, measure, box);
    expect(layout.pictures).toHaveLength(5);
    expect(layout.mode).toBe('numbered');
    expect(new Set(layout.pictures.map((placed) => Math.round(placed.y))).size).toBe(1);
    expect(layout.pictures[0]!.height / PPM).toBeGreaterThan(0.15);
    expectSound(layout, box, given);
    {
      // The number under each card is the one its caption is listed with.
      expect(layout.lines.some((line) => line.text === String(from + 1))).toBe(true);
      expect(layout.badges).toHaveLength(5);
      expect(layout.lines.some((line) => line.text.startsWith(`${from + 5}. `))).toBe(true);
    }
  });

  it('numbers the cards when a word is wider than a card', () => {
    const given = content(cards(['Supercalifragilistic', 'B', 'C', 'D', 'E']));
    const layout = layoutCards(given, measure, SCREEN_BOX);
    expect(layout.mode).toBe('numbered');
    expectSound(layout, SCREEN_BOX, given);
  });

  it('shows ten at most, then "+N more"; a card with no picture keeps its place', () => {
    const many = Array.from({ length: 12 }, (_, index) => ({ caption: `C${index + 1}`, picture: null, flip: false }));
    const layout = layoutCards(content(many), measure, WHITEBOARD_BOX);
    expect(layout.pictures).toHaveLength(10);
    expect(layout.omitted).toBe(2);
    expect(layout.lines.at(-1)?.text).toBe('+2 more');
    expect(layout.pictures.every((placed) => placed.picture === null)).toBe(true);
  });

  it('draws nothing for no cards but the title', () => {
    const layout = layoutCards(content([]), measure, SCREEN_BOX);
    expect(layout.pictures).toEqual([]);
    expect(layout.lines.map((line) => line.text)).toEqual(['A reading']);
  });
});
