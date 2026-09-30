import type { CancellationSignal, JsonObject, McpToolInfo } from '@latentpresence/protocol';

/**
 * The permission gate for tools that reach outside (P5-T01, ADR-42).
 *
 * **Per tool: auto, ask, never.** A tool nobody has decided about is **ask**. "Always allow"
 * is kept with a fingerprint of what the tool said it does — its description and its schema —
 * so a tool that changes after it was trusted is asked about again: a server that renames
 * `search` into something that deletes does not inherit the trust.
 *
 * **Asking is a queue the page shows.** `PermissionPrompts.ask` waits for the person; Stop or a
 * barge-in (the answer's cancellation) or two minutes of silence is a refusal, and the tool
 * says which, so she can tell them.
 */

export type ToolPolicy = 'auto' | 'ask' | 'never';

export interface ToolGrant {
  readonly policy: ToolPolicy;
  /** For `auto`: the fingerprint of the tool as it was when the person trusted it. */
  readonly fingerprint: string | null;
}

/** Where the person's decisions live — the page keeps them in its settings. */
export interface ToolGrants {
  get(serverId: string, tool: string): ToolGrant | undefined;
  set(serverId: string, tool: string, grant: ToolGrant): void;
}

/** JSON with its keys sorted, so the same schema always prints the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * What a tool says it does, as a short stable string: FNV-1a over its canonical description and
 * schema. Not a security hash — a change detector; the server could lie in either version.
 */
export function toolFingerprint(tool: Pick<McpToolInfo, 'description' | 'inputSchema'>): string {
  const text = canonical({ description: tool.description, inputSchema: tool.inputSchema });
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** What applies now: undecided is ask; trusted, then changed, is ask again. */
export function effectivePolicy(grant: ToolGrant | undefined, tool: Pick<McpToolInfo, 'description' | 'inputSchema'>): { readonly policy: ToolPolicy; readonly changed: boolean } {
  if (grant === undefined) return { policy: 'ask', changed: false };
  if (grant.policy === 'auto' && grant.fingerprint !== toolFingerprint(tool)) return { policy: 'ask', changed: true };
  return { policy: grant.policy, changed: false };
}

export type PermissionDecision = 'once' | 'always' | 'deny';
/** How an ask ended: the person's answer, or no answer. */
export type PermissionOutcome = { readonly decision: PermissionDecision } | { readonly decision: 'deny'; readonly reason: 'stopped' | 'timeout' };

export interface PermissionRequest {
  readonly id: string;
  readonly serverId: string;
  readonly serverName: string;
  readonly tool: string;
  readonly description: string;
  readonly args: JsonObject;
  /** She trusted this tool before and it has changed since. */
  readonly changed: boolean;
  readonly at: string;
}

/** Two minutes: long enough to read the arguments, short enough that she is not left hanging. */
export const PERMISSION_TIMEOUT_MS = 120_000;

interface Pending {
  readonly request: PermissionRequest;
  readonly settle: (outcome: PermissionOutcome) => void;
}

export interface PermissionTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export class PermissionPrompts {
  private pending: Pending[] = [];
  private snapshotValue: readonly PermissionRequest[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly timeoutMs: number;
  private readonly timers: PermissionTimers;
  private readonly now: () => Date;
  private next = 0;

  /** `timers` from the host (core has none of its own — the page passes `hostTimers()`). */
  constructor(options: { readonly timers: PermissionTimers; readonly timeoutMs?: number; readonly now?: () => Date }) {
    this.timeoutMs = options.timeoutMs ?? PERMISSION_TIMEOUT_MS;
    this.timers = options.timers;
    this.now = options.now ?? (() => new Date());
  }

  /** The asks waiting on the person, oldest first. A new array on every change. */
  snapshot(): readonly PermissionRequest[] {
    return this.snapshotValue;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Wait for the person. Cancellation (Stop, barge-in) and the timeout both refuse. */
  ask(request: Omit<PermissionRequest, 'id' | 'at'>, signal?: CancellationSignal): Promise<PermissionOutcome> {
    if (signal?.aborted === true) return Promise.resolve({ decision: 'deny', reason: 'stopped' });
    this.next += 1;
    const full: PermissionRequest = { ...request, id: `ask-${this.next}`, at: this.now().toISOString() };
    return new Promise((resolve) => {
      let done = false;
      const onAbort = (): void => finish({ decision: 'deny', reason: 'stopped' });
      const timer = this.timers.setTimeout(() => finish({ decision: 'deny', reason: 'timeout' }), this.timeoutMs);
      const finish = (outcome: PermissionOutcome): void => {
        if (done) return;
        done = true;
        this.timers.clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.pending = this.pending.filter((entry) => entry.request.id !== full.id);
        this.changed();
        resolve(outcome);
      };
      signal?.addEventListener('abort', onAbort);
      this.pending = [...this.pending, { request: full, settle: finish }];
      this.changed();
    });
  }

  /** The person's answer. Unknown or already settled ids are ignored. */
  answer(id: string, decision: PermissionDecision): void {
    this.pending.find((entry) => entry.request.id === id)?.settle({ decision });
  }

  private changed(): void {
    this.snapshotValue = this.pending.map((entry) => entry.request);
    for (const listener of this.listeners) listener();
  }
}
