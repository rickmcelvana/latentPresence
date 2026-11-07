import { useCallback, useEffect, useMemo, useState } from 'react';
import { DEFAULT_CARD_ASPECT, placeOnWall, type BoardPicture, type PluginBoardContent, type PluginWall } from '@latentpresence/avatar';
import type { PluginDisplay } from '@latentpresence/core';

/**
 * A plugin's layout on the room's boards (P10-T05, ADR-72 item 6). A `show` step's layout stays until
 * another replaces it or the person clears the wall; then the plan and the sources come back. Its
 * pictures come only from the plugin's pinned assets (checked, cached, ADR-70), decoded here into
 * images the boards draw: the `img-src` policy is unchanged, since nothing is loaded by URL.
 */

/** A decoded picture: what a canvas can draw, with its size for the cards' aspect. */
export type DecodedPicture = CanvasImageSource & { readonly width: number; readonly height: number; close?: () => void };

/** One of the plugin's pinned pictures by asset id, as checked bytes. */
export type PluginPictures = (assetId: string) => Promise<Blob>;

export interface Shown {
  readonly display: PluginDisplay;
  readonly pictures: PluginPictures;
}

/**
 * The layout as the boards take it: a picture by its asset id, loaded or not yet. While the screen is
 * hidden (the call's drawer covers the right of the room, where it hangs: R-68, 2026-11-06, a three-card
 * reading drawn behind the open transcript), a layout for the screen alone goes on the whiteboard.
 */
export function pluginWall(display: PluginDisplay, decoded: ReadonlyMap<string, DecodedPicture | null>, screenHidden = false): PluginWall {
  let content: PluginBoardContent;
  if (display.layout === 'list') {
    content = { layout: 'list', title: display.title, lines: display.items.map((item) => item.caption) };
  } else {
    const first = display.items.map((item) => (item.image === null ? null : (decoded.get(item.image) ?? null))).find((picture) => picture !== null && picture.height > 0);
    content = {
      layout: 'cards',
      title: display.title,
      aspect: first === undefined || first === null ? DEFAULT_CARD_ASPECT : first.width / first.height,
      firstNumber: 1,
      cards: display.items.map((item) => ({
        caption: item.caption,
        flip: item.flip,
        picture: item.image === null ? null : ({ id: item.image, source: decoded.get(item.image) ?? null } satisfies BoardPicture),
      })),
    };
  }
  return placeOnWall(content, screenHidden && display.where === 'screen' ? 'whiteboard' : display.where);
}

/** The layout on the wall and its pictures so far; `pluginWall` places it. */
export interface ShownLayout {
  readonly display: PluginDisplay;
  readonly decoded: ReadonlyMap<string, DecodedPicture | null>;
}

export interface PluginWallState {
  /** What a plugin put on the boards, or null: they show their own content. */
  readonly layout: ShownLayout | null;
  readonly show: (display: PluginDisplay, pictures: PluginPictures) => void;
  readonly clear: () => void;
}

const decodeBlob = (blob: Blob): Promise<DecodedPicture> => createImageBitmap(blob);

/**
 * The wall's state for `/chat`. Each picture is decoded once per layout; a picture that fails stays
 * a blank card (warned in the console), and the reading goes on. Decoded images of a layout that is
 * replaced or cleared are let go.
 */
export function usePluginWall(decode: (blob: Blob) => Promise<DecodedPicture> = decodeBlob): PluginWallState {
  // The first decoder given is the one used: a new function each render would decode again each render.
  const [decodeWith] = useState(() => decode);
  const [shown, setShown] = useState<Shown | null>(null);
  const [decoded, setDecoded] = useState<ReadonlyMap<string, DecodedPicture | null>>(() => new Map());

  useEffect(() => {
    if (shown === null) return undefined;
    let cancelled = false;
    const kept: DecodedPicture[] = [];
    const ids = [...new Set(shown.display.items.flatMap((item) => (item.image === null ? [] : [item.image])))];
    for (const id of ids) {
      void shown
        .pictures(id)
        .then(decodeWith)
        .then((picture) => {
          if (cancelled) {
            picture.close?.();
            return;
          }
          kept.push(picture);
          setDecoded((prev) => new Map(prev).set(id, picture));
        })
        .catch((error: unknown) => {
          console.warn(`plugin ${shown.display.pluginId}: picture "${id}" not shown: ${error instanceof Error ? error.message : String(error)}`);
        });
    }
    return () => {
      cancelled = true;
      for (const picture of kept) picture.close?.();
    };
  }, [shown, decodeWith]);

  const show = useCallback((display: PluginDisplay, pictures: PluginPictures) => {
    setDecoded(new Map());
    setShown({ display, pictures });
  }, []);
  const clear = useCallback(() => {
    setDecoded(new Map());
    setShown(null);
  }, []);
  const layout = useMemo(() => (shown === null ? null : { display: shown.display, decoded }), [shown, decoded]);
  return { layout, show, clear };
}
