import type { CancellationSignal } from '@latentpresence/protocol';
import type { PermissionTimers } from '../tools/gate';

/** Timers a test fires by hand. */
export class ManualTimers implements PermissionTimers {
  private handles = new Map<number, { fn: () => void; ms: number }>();
  private next = 0;
  setTimeout(fn: () => void, ms: number): unknown {
    this.next += 1;
    this.handles.set(this.next, { fn, ms });
    return this.next;
  }
  clearTimeout(handle: unknown): void {
    this.handles.delete(handle as number);
  }
  get size(): number {
    return this.handles.size;
  }
  fireAll(): void {
    const due = [...this.handles.values()];
    this.handles.clear();
    for (const entry of due) entry.fn();
  }
  delays(): number[] {
    return [...this.handles.values()].map((entry) => entry.ms);
  }
}

/** A `CancellationSignal` a test aborts by hand. */
export function manualSignal(): CancellationSignal & { abort(): void } {
  const listeners = new Set<() => void>();
  const signal = {
    aborted: false,
    addEventListener: (_type: 'abort', listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: 'abort', listener: () => void) => listeners.delete(listener),
    abort() {
      signal.aborted = true;
      for (const listener of listeners) listener();
    },
  };
  return signal;
}
