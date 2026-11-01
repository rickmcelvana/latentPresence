import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * P9-T01: WCAG 2.2 contrast of the colour pairs `theme.css` really uses.
 *
 * axe's `color-contrast` rule cannot run under jsdom (no layout, no canvas), so this is
 * where contrast is checked: the tokens are read from `:root`, the pairs below are the
 * ones the stylesheet puts together, and each is held to the threshold its use needs --
 * 4.5 for text, 3 for focus indicators and for the border that is the only thing marking
 * a control's edge (1.4.11). A pair that falls short and waits on a person's decision can be
 * marked `reported` with the ratio it measured: it is then expected to fail (`it.fails`), and
 * fails the other way the day the token is fixed. None is now: the control borders have their
 * own token, `--border-control` (P9-T01, ADR-67).
 *
 * theme.css has one theme, dark: there is no light block or `prefers-color-scheme` rule to
 * read. A translucent surface (`--bg-elev`) is blended over the ground it sits on.
 */

const SRC = dirname(fileURLToPath(import.meta.url));
const themeCss = readFileSync(join(SRC, 'theme.css'), 'utf8');

const TEXT = 4.5;
const NON_TEXT = 3;

interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/** The `--name: value;` declarations of the first `:root` rule. */
export function rootTokens(css: string): Map<string, string> {
  const rule = /:root\s*\{([^}]*)\}/u.exec(css.replace(/\/\*[\s\S]*?\*\//gu, ''));
  if (rule?.[1] === undefined) throw new Error('theme.css has no :root rule');
  const found = new Map<string, string>();
  for (const [, name, value] of rule[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/gu)) {
    if (name !== undefined && value !== undefined) found.set(name, value.trim());
  }
  return found;
}

/** `#rgb`, `#rrggbb`, `#rrggbbaa` or `rgba(r, g, b, a)`. */
export function parseColour(value: string): Rgba {
  const hex = /^#([\da-f]{3,8})$/iu.exec(value)?.[1];
  if (hex !== undefined) {
    const full = hex.length <= 4 ? [...hex].map((digit) => digit + digit).join('') : hex;
    if (full.length !== 6 && full.length !== 8) throw new Error(`not a colour: ${value}`);
    const byte = (at: number): number => Number.parseInt(full.slice(at, at + 2), 16);
    return { r: byte(0), g: byte(2), b: byte(4), a: full.length === 8 ? byte(6) / 255 : 1 };
  }
  const fn = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/iu.exec(value);
  if (fn !== null) return { r: Number(fn[1]), g: Number(fn[2]), b: Number(fn[3]), a: fn[4] === undefined ? 1 : Number(fn[4]) };
  throw new Error(`not a colour: ${value}`);
}

/** `top` laid over `under`, as the browser composites it. */
function over(top: Rgba, under: Rgba): Rgba {
  const mix = (a: number, b: number): number => a * top.a + b * (1 - top.a);
  return { r: mix(top.r, under.r), g: mix(top.g, under.g), b: mix(top.b, under.b), a: 1 };
}

/** One sRGB channel (0-255) to linear light (the 0.04045 knee WCAG 2.2 uses). */
function linear(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.2 relative luminance. */
function luminance(colour: Rgba): number {
  return 0.2126 * linear(colour.r) + 0.7152 * linear(colour.g) + 0.0722 * linear(colour.b);
}

export function contrastRatio(a: Rgba, b: Rgba): number {
  const [light, dark] = [luminance(a), luminance(b)].toSorted((x, y) => y - x);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

const tokens = rootTokens(themeCss);

/** A token by its name without the dashes; a translucent one is blended over `ground`. */
function token(name: string, ground?: Rgba): Rgba {
  const value = tokens.get(`--${name}`);
  if (value === undefined) throw new Error(`theme.css has no --${name}`);
  const colour = parseColour(value);
  return colour.a === 1 || ground === undefined ? colour : over(colour, ground);
}

/** What a name in a pair stands for: a token, or a token blended over what it sits on. */
function surface(name: string): Rgba {
  const bg = token('bg');
  switch (name) {
    // The call bar: `--bg-elev` over whatever the stage shows. The stage is the avatar's
    // room, which this test cannot know; the page ground is the stand-in.
    case 'bar':
      return token('bg-elev', bg);
    // The pressed call button: `--accent-glow` over the bar.
    case 'accent-glow-on-bar':
      return over(token('accent-glow'), surface('bar'));
    // The current nav link: `--accent-glow` over the nav's `--bg`.
    case 'accent-glow-on-bg':
      return over(token('accent-glow'), bg);
    default:
      return token(name, bg);
  }
}

interface Pair {
  readonly fg: string;
  readonly bg: string;
  readonly min: number;
  /** Where the stylesheet puts them together. */
  readonly where: string;
  /** Measured to fall short and reported: the test expects it to fail (see the file comment). */
  readonly reported?: true;
}

const PAIRS: readonly Pair[] = [
  // Body text.
  { fg: 'text', bg: 'bg', min: TEXT, where: 'body, .input, .textarea, .select text' },
  { fg: 'text', bg: 'panel', min: TEXT, where: '.panel, .drawer text' },
  { fg: 'text', bg: 'panel-hover', min: TEXT, where: '.btn label' },
  { fg: 'text', bg: 'bar', min: TEXT, where: '.call-controls-bar' },
  { fg: 'text-muted', bg: 'bg', min: TEXT, where: '.field-label, .field-hint, .panel-note, .app-nav-link, placeholders on the page ground' },
  { fg: 'text-muted', bg: 'panel', min: TEXT, where: '.panel-note, .field-hint, .pill, .btn-ghost, .transcript-line-tool inside panels and the drawer' },
  { fg: 'text-muted', bg: 'panel-hover', min: TEXT, where: '.btn-ghost on a hovered row' },
  { fg: 'accent', bg: 'bg', min: TEXT, where: 'a, .app-nav-brand, .pill-accent' },
  { fg: 'accent', bg: 'panel', min: TEXT, where: 'a and .pill-accent inside a panel' },
  { fg: 'accent-hover', bg: 'bg', min: TEXT, where: 'a:hover' },
  { fg: 'accent', bg: 'accent-glow-on-bg', min: TEXT, where: ".app-nav-link[aria-current='page']" },
  { fg: 'accent', bg: 'accent-glow-on-bar', min: TEXT, where: ".call-control-btn[aria-pressed='true']" },
  { fg: 'on-accent', bg: 'accent', min: TEXT, where: '.btn-primary' },
  { fg: 'on-accent', bg: 'accent-hover', min: TEXT, where: '.btn-primary:hover' },
  { fg: 'danger', bg: 'bg', min: TEXT, where: '.field-error, .btn-danger, .pill-danger on the page ground' },
  { fg: 'danger', bg: 'panel', min: TEXT, where: '.field-error, .btn-danger, .pill-danger inside a panel' },
  { fg: 'success', bg: 'panel', min: TEXT, where: '.pill-ok' },
  { fg: 'warning', bg: 'panel', min: TEXT, where: '.pill-warn' },
  // Captions (P9-T01): on `--scrim` over the stage, which the page ground stands in for.
  { fg: 'text', bg: 'scrim', min: TEXT, where: '.call-captions' },
  { fg: 'accent', bg: 'scrim', min: TEXT, where: '.call-captions-speaker' },

  // Focus indicators: `:focus-visible` draws a 2px accent outline, 2px off its element,
  // so it is measured against the surface the element sits on.
  { fg: 'accent', bg: 'bg', min: NON_TEXT, where: ':focus-visible ring on the page ground' },
  { fg: 'accent', bg: 'panel', min: NON_TEXT, where: ':focus-visible ring inside a panel or the drawer' },
  { fg: 'accent', bg: 'bar', min: NON_TEXT, where: ':focus-visible ring on the call bar' },

  // Control borders: where the border is what shows the edge of a control, 1.4.11 asks 3:1.
  { fg: 'border-control', bg: 'bg', min: NON_TEXT, where: '.input, .textarea, .select, .btn, .btn-ghost border on the page ground' },
  { fg: 'border-control', bg: 'panel', min: NON_TEXT, where: '.input, .textarea, .select, .btn, .btn-ghost border inside a panel or the drawer' },
  { fg: 'text-muted', bg: 'panel', min: NON_TEXT, where: '.input:hover, .btn-ghost:hover border' },
  { fg: 'danger', bg: 'bg', min: NON_TEXT, where: ".btn-danger border, .input[aria-invalid='true'] border" },
];

/** A pair's name as the test lists it. */
const nameOf = (pair: Pair): string => `${pair.fg} on ${pair.bg} >= ${pair.min} (${pair.where})`;

describe('theme.css :root', () => {
  it('reads every colour token the pairs below use', () => {
    for (const pair of PAIRS) {
      expect(() => surface(pair.fg), pair.fg).not.toThrow();
      expect(() => surface(pair.bg), pair.bg).not.toThrow();
    }
  });
});

describe('contrastRatio', () => {
  it('is 21 for black on white and 1 for a colour on itself (WCAG 2.2 reference values)', () => {
    expect(contrastRatio(parseColour('#000000'), parseColour('#ffffff'))).toBeCloseTo(21, 5);
    expect(contrastRatio(parseColour('#2dd4bf'), parseColour('#2dd4bf'))).toBeCloseTo(1, 5);
  });

  it('reads the colour forms theme.css writes', () => {
    expect(parseColour('#11161f99').a).toBeCloseTo(0.6, 2);
    expect(parseColour('rgba(45, 212, 191, 0.22)')).toEqual({ r: 45, g: 212, b: 191, a: 0.22 });
    expect(parseColour('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
  });
});

describe('contrast of the colour pairs theme.css uses (WCAG 2.2)', () => {
  for (const pair of PAIRS) {
    const ratio = (): number => contrastRatio(surface(pair.fg), surface(pair.bg));
    const check = (): void => {
      expect(ratio(), `${pair.fg} on ${pair.bg} is ${ratio().toFixed(2)}:1`).toBeGreaterThanOrEqual(pair.min);
    };
    if (pair.reported === true) it.fails(nameOf(pair), check);
    else it(nameOf(pair), check);
  }
});
