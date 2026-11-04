/**
 * The call's control bar wraps when the window is narrower than its buttons, about 1440 px. What
 * floats over the stage is placed above `--call-bar-height`, so that has to grow with the rows.
 *
 * A ref callback, so it works wherever the bar renders; the cleanup it returns is React 19's. One row
 * leaves the stylesheet's height alone, which also keeps the zoomed overlays of a large screen out of
 * this: a screen that zooms them is far wider than the bar.
 */
export function watchControlBar(bar: HTMLElement | null): (() => void) | undefined {
  if (bar === null || typeof ResizeObserver === 'undefined') return undefined;
  const page = bar.closest<HTMLElement>('.call-page');
  const fit = (): void => {
    // Controls differ in height by a pixel or two, so a new row is one that starts below the first control.
    const controls = bar.querySelectorAll<HTMLElement>('button, a, select');
    const first = controls[0];
    const last = controls[controls.length - 1];
    const wrapped = first !== undefined && last !== undefined && last.offsetTop >= first.offsetTop + first.offsetHeight;
    bar.classList.toggle('call-controls-bar-wrapped', wrapped);
    if (wrapped) {
      const offset = Number.parseFloat(getComputedStyle(bar).bottom) || 0;
      page?.style.setProperty('--call-bar-height', `${bar.offsetHeight + offset}px`);
    } else {
      page?.style.removeProperty('--call-bar-height');
    }
  };
  const observer = new ResizeObserver(fit);
  observer.observe(bar);
  fit();
  return () => {
    observer.disconnect();
    page?.style.removeProperty('--call-bar-height');
  };
}
