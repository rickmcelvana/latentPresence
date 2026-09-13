import type { CancellationSignal } from '@latentpresence/protocol';

/**
 * A cancellation signal with no DOM behind it. `packages/core` compiles against ES2023
 * alone, where `AbortController` does not exist; a real `AbortSignal` satisfies the same
 * protocol interface, so providers cannot tell the difference.
 */
export class Cancellation implements CancellationSignal {
  private isAborted = false;
  private readonly listeners = new Set<() => void>();

  get aborted(): boolean {
    return this.isAborted;
  }

  addEventListener(_type: 'abort', listener: () => void): void {
    if (!this.isAborted) this.listeners.add(listener);
  }

  removeEventListener(_type: 'abort', listener: () => void): void {
    this.listeners.delete(listener);
  }

  abort(): void {
    if (this.isAborted) return;
    this.isAborted = true;
    const listeners = [...this.listeners];
    this.listeners.clear();
    for (const listener of listeners) listener();
  }
}
