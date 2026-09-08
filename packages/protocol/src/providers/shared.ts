/**
 * The structural part of `AbortSignal` the providers use.
 *
 * A real `AbortSignal` satisfies this, but declaring it structurally keeps this package
 * off the DOM lib: `packages/protocol` must compile with nothing but ES2023, or a stray
 * `document` reference eventually finds its way into code the companion has to run.
 */
export interface CancellationSignal {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

/** Options every provider call accepts. Cancellation is how barge-in stops a stream. */
export interface ProviderCallOptions {
  readonly signal?: CancellationSignal;
}
