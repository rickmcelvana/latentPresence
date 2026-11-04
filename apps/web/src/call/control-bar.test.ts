// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchControlBar } from './control-bar';

let fired: (() => void)[] = [];
const disconnect = vi.fn();

beforeEach(() => {
  fired = [];
  disconnect.mockClear();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        fired.push(callback);
      }
      observe(): void {}
      disconnect(): void {
        disconnect();
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A bar in a page, with the layout jsdom does not do given by hand. */
function makeBar(): { page: HTMLElement; bar: HTMLElement; lastTop: (top: number) => void } {
  const page = document.createElement('main');
  page.className = 'call-page';
  const bar = document.createElement('div');
  bar.style.bottom = '12px';
  const first = document.createElement('button');
  const last = document.createElement('button');
  bar.append(first, last);
  page.append(bar);
  document.body.append(page);
  Object.defineProperty(first, 'offsetTop', { value: 8 });
  Object.defineProperty(first, 'offsetHeight', { value: 40 });
  let top = 8;
  Object.defineProperty(last, 'offsetTop', { get: () => top });
  Object.defineProperty(bar, 'offsetHeight', { value: 108 });
  return { page, bar, lastTop: (next) => { top = next; } };
}

describe('watchControlBar', () => {
  it('leaves the stylesheet alone on one row', () => {
    const { page, bar } = makeBar();
    watchControlBar(bar);
    expect(page.style.getPropertyValue('--call-bar-height')).toBe('');
    expect(bar.classList.contains('call-controls-bar-wrapped')).toBe(false);
  });

  it('raises what floats above the bar by the rows it wrapped into, and lets it back down', () => {
    const { page, bar, lastTop } = makeBar();
    watchControlBar(bar);

    lastTop(60);
    fired[0]?.();
    expect(page.style.getPropertyValue('--call-bar-height')).toBe('120px');
    expect(bar.classList.contains('call-controls-bar-wrapped')).toBe(true);

    lastTop(8);
    fired[0]?.();
    expect(page.style.getPropertyValue('--call-bar-height')).toBe('');
    expect(bar.classList.contains('call-controls-bar-wrapped')).toBe(false);
  });

  it('stops watching, and takes its height back, when the bar goes', () => {
    const { page, bar, lastTop } = makeBar();
    lastTop(60);
    const stop = watchControlBar(bar);
    expect(page.style.getPropertyValue('--call-bar-height')).toBe('120px');
    stop?.();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(page.style.getPropertyValue('--call-bar-height')).toBe('');
  });

  it('does nothing without a bar, or where the browser has no ResizeObserver', () => {
    expect(watchControlBar(null)).toBeUndefined();
    vi.stubGlobal('ResizeObserver', undefined);
    expect(watchControlBar(makeBar().bar)).toBeUndefined();
  });
});
