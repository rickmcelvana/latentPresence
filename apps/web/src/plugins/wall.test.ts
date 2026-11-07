import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginDisplay } from '@latentpresence/core';
import { DEFAULT_CARD_ASPECT } from '@latentpresence/avatar';
import { pluginWall, usePluginWall, type DecodedPicture, type PluginWallState } from './wall';

afterEach(() => vi.restoreAllMocks());

/** The wall (P10-T05, ADR-72 item 6): a `show` step's layout as the boards take it, and how long it stays. */

function display(count: number, overrides: Partial<PluginDisplay> = {}): PluginDisplay {
  return {
    pluginId: 'tarot',
    board: 'spread',
    layout: 'cards',
    where: 'screen',
    title: 'A reading',
    items: Array.from({ length: count }, (_, index) => ({ caption: `Card ${index + 1}`, image: `card-${index + 1}`, flip: index === 1 })),
    ...overrides,
  };
}

/** The hook's layout, placed as the page places it with the drawer closed. */
function wallOf(state: PluginWallState) {
  return state.layout === null ? null : pluginWall(state.layout.display, state.layout.decoded);
}

/** The cards on the screen, or none. */
function cardsOf(state: PluginWallState) {
  const screen = wallOf(state)?.screen;
  return screen?.layout === 'cards' ? screen.cards : [];
}

function picture(width = 250, height = 419): DecodedPicture & { closed: boolean } {
  const made = { width, height, closed: false, close: () => (made.closed = true) };
  return made as unknown as DecodedPicture & { closed: boolean };
}

describe('pluginWall', () => {
  it('puts three cards on the board the plugin named, waiting for their pictures', () => {
    const wall = pluginWall(display(3), new Map());
    expect(wall.whiteboard).toBeNull();
    expect(wall.screen).toEqual({
      layout: 'cards',
      title: 'A reading',
      aspect: DEFAULT_CARD_ASPECT,
      firstNumber: 1,
      cards: [
        { caption: 'Card 1', flip: false, picture: { id: 'card-1', source: null } },
        { caption: 'Card 2', flip: true, picture: { id: 'card-2', source: null } },
        { caption: 'Card 3', flip: false, picture: { id: 'card-3', source: null } },
      ],
    });
  });

  it('takes the aspect from the first picture that has loaded', () => {
    const wall = pluginWall(display(2), new Map([['card-2', picture(300, 500)]]));
    expect(wall.screen?.layout === 'cards' && wall.screen.aspect).toBeCloseTo(0.6, 6);
  });

  it('spans a ten-card spread over both boards, left to right', () => {
    const wall = pluginWall(display(10), new Map());
    expect(wall.whiteboard?.layout === 'cards' && wall.whiteboard.cards.map((card) => card.caption)).toEqual(['Card 1', 'Card 2', 'Card 3', 'Card 4', 'Card 5']);
    expect(wall.screen).toMatchObject({ title: null, firstNumber: 6 });
  });

  it('moves a layout for the screen to the whiteboard while the drawer hides the screen (R-68)', () => {
    expect(pluginWall(display(3), new Map(), true)).toMatchObject({ whiteboard: { layout: 'cards', title: 'A reading' }, screen: null });
    // A layout across both boards stays as it is: half of it is behind the drawer, and closing it shows it.
    expect(pluginWall(display(10), new Map(), true)).toEqual(pluginWall(display(10), new Map(), false));
    expect(pluginWall(display(3, { where: 'whiteboard' }), new Map(), true).whiteboard).not.toBeNull();
  });

  it('shows a list as its lines, on its board', () => {
    const wall = pluginWall(display(0, { layout: 'list', where: 'whiteboard', title: 'Rolls', items: [{ caption: '2d6: 7', image: null, flip: false }] }), new Map());
    expect(wall).toEqual({ whiteboard: { layout: 'list', title: 'Rolls', lines: ['2d6: 7'] }, screen: null });
  });
});

/** Every picture but the second. */
async function failingSecond(id: string): Promise<Blob> {
  if (id === 'card-2') throw new Error('it no longer matches its SHA-256');
  return new Blob([id]);
}

describe('usePluginWall', () => {
  it('decodes each picture once, holds the layout until cleared, and lets the pictures go', async () => {
    const made: ReturnType<typeof picture>[] = [];
    const decode = vi.fn(async () => {
      const next = picture();
      made.push(next);
      return next;
    });
    const asked: string[] = [];
    const pictures = async (id: string) => {
      asked.push(id);
      return new Blob([id], { type: 'image/jpeg' });
    };
    const { result } = renderHook(() => usePluginWall(decode));
    expect(wallOf(result.current)).toBeNull();

    act(() => result.current.show({ ...display(3), items: [...display(3).items, { caption: 'Again', image: 'card-1', flip: false }] }, pictures));
    expect(wallOf(result.current)?.screen?.layout).toBe('cards');
    await waitFor(() => expect(cardsOf(result.current).length === 4 && cardsOf(result.current).every((card) => card.picture?.source !== null)).toBe(true));
    expect(asked.toSorted()).toEqual(['card-1', 'card-2', 'card-3']);
    expect(decode).toHaveBeenCalledTimes(3);

    act(() => result.current.clear());
    expect(wallOf(result.current)).toBeNull();
    expect(made.every((one) => one.closed)).toBe(true);
  });

  it('keeps a card whose picture fails blank, says so in the console, and shows the rest', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = renderHook(() => usePluginWall(async () => picture()));
    act(() => result.current.show(display(3), failingSecond));
    await waitFor(() => expect(warn).toHaveBeenCalledWith('plugin tarot: picture "card-2" not shown: it no longer matches its SHA-256'));
    await waitFor(() => expect(cardsOf(result.current).map((card) => card.picture?.source !== null)).toEqual([true, false, true]));
  });

  it('replaces one layout with the next, letting the old pictures go', async () => {
    const first = picture();
    const decodes = [first, picture()];
    const { result } = renderHook(() => usePluginWall(async () => decodes.shift() ?? picture()));
    act(() => result.current.show(display(1), async () => new Blob(['a'])));
    await waitFor(() => expect(cardsOf(result.current)[0]?.picture?.source).toBe(first));
    act(() => result.current.show(display(1, { title: 'Another' }), async () => new Blob(['b'])));
    expect(first.closed).toBe(true);
    expect(wallOf(result.current)?.screen).toMatchObject({ title: 'Another', cards: [{ picture: { source: null } }] });
  });
});
