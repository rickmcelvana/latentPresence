import type { ConversationEvent, ConversationState } from '@latentpresence/protocol';
import { createConversationBus, type ConversationBus, type ConversationListener } from './bus';
import { transition } from './transition';
import type { Ports } from './ports';

/** Minimal timer abstraction so the machine never depends on a host timer API. */
export interface Scheduler {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * A session end reason. `idle` is produced by the machine's own idle timer; `user` and
 * `error` are chosen by the caller of {@link ConversationMachine.end}.
 */
export type EndReason = 'user' | 'idle' | 'error';

export interface ConversationMachineOptions {
  /** Identifier echoed on every event the machine emits (P1-T01). */
  sessionId: string;
  /** The character this conversation belongs to (P1-T12 persona; Alice today). */
  characterId: string;
  /**
   * Host timers. Omit to run with timers disabled (pure state machine); the browser
   * wiring (P1-T07/P1-T08) supplies a `setTimeout`-backed scheduler.
   */
  scheduler?: Scheduler;
  /** Wall clock for event timestamps; default is `Date.now().toISOString`. */
  now?: () => string;
  /** Auto-end an idle `listening` session after this many ms; 0 disables (default 0). */
  idleTimeoutMs?: number;
  /** Barge-in teardown duration after which `interrupted` returns to `listening`.
   * P1-T08 replaces this default timer with the real 100ms AudioWorklet fade. */
  fadeOutMs?: number;
  /** The ports the machine reaches; all optional for headless operation. */
  ports?: Ports;
}

/**
 * The conversation state machine (P1-T01). Owns the current {@link ConversationState},
 * applies the explicit {@link transitionTable} to every incoming event, emits the
 * machine's own events (`session.started`, `session.ended`, `state.changed`) and passes
 * every event through a typed {@link ConversationBus} for observers.
 *
 * No DOM and no audio APIs: timing goes through an injected {@link Scheduler} and the
 * world is reached only through {@link Ports}.
 */
export class ConversationMachine {
  private readonly bus: ConversationBus;
  private readonly scheduler: Scheduler | undefined;
  private readonly now: () => string;
  private readonly sessionId: string;
  private readonly characterId: string;
  private readonly idleTimeoutMs: number;
  private readonly fadeOutMs: number;
  private readonly ports: Ports;

  private current: ConversationState = 'idle';
  private idleHandle: unknown | undefined;
  private teardownHandle: unknown | undefined;

  constructor(options: ConversationMachineOptions) {
    this.sessionId = options.sessionId;
    this.characterId = options.characterId;
    this.scheduler = options.scheduler;
    this.now = options.now ?? (() => new Date().toISOString());
    this.idleTimeoutMs = options.idleTimeoutMs ?? 0;
    this.fadeOutMs = options.fadeOutMs ?? 100;
    this.ports = options.ports ?? {};

    this.bus = createConversationBus();
  }

  getState(): ConversationState {
    return this.current;
  }

  /** Expose the seams so later wiring (P1-T05…T08) can read what it must implement. */
  getPorts(): Readonly<Ports> {
    return this.ports;
  }

  /** Subscribe to every event the machine emits or passes through. */
  subscribe(listener: ConversationListener): () => void {
    return this.bus.subscribe(listener);
  }

  /** Begin a session: emit `session.started`, then move `idle → listening`. */
  start(): void {
    this.bus.emit({
      sessionId: this.sessionId,
      characterId: this.characterId,
      at: this.now(),
      type: 'session.started',
    });
    this.transitionByTrigger('session.started');
  }

  /** End a session: emit `session.ended`, then return to `idle`. */
  end(reason: EndReason): void {
    this.bus.emit({
      sessionId: this.sessionId,
      at: this.now(),
      type: 'session.ended',
      reason,
    });
    this.transitionByTrigger('session.ended');
  }

  /**
   * Feed an external event in (from a port, the UI or a timer): pass it straight
   * through the bus, then apply the transition table.
   */
  dispatch(event: ConversationEvent): void {
    this.bus.emit(event);
    this.transitionByTrigger(event.type);
    // Any activity while listening keeps the idle auto-end at bay.
    if (this.current === 'listening') {
      this.resetIdleTimer();
    }
  }

  private transitionByTrigger(trigger: ConversationEvent['type']): void {
    const next = transition(this.current, trigger);
    if (next !== this.current) {
      this.setState(next);
    }
  }

  private setState(next: ConversationState): void {
    const from = this.current;
    this.current = next;
    this.bus.emit({
      sessionId: this.sessionId,
      at: this.now(),
      type: 'state.changed',
      from,
      to: next,
    });
    this.onEnter(next);
  }

  private onEnter(state: ConversationState): void {
    this.clearTimers();
    if (state === 'listening') {
      this.resetIdleTimer();
    } else if (state === 'interrupted') {
      this.startTeardownTimer();
    }
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer();
    if (this.scheduler === undefined || this.idleTimeoutMs <= 0) {
      return;
    }
    this.idleHandle = this.scheduler.setTimeout(() => {
      this.idleHandle = undefined;
      this.end('idle');
    }, this.idleTimeoutMs);
  }

  private clearIdleTimer(): void {
    if (this.idleHandle !== undefined) {
      this.scheduler?.clearTimeout(this.idleHandle);
      this.idleHandle = undefined;
    }
  }

  private startTeardownTimer(): void {
    if (this.scheduler === undefined || this.fadeOutMs <= 0) {
      return;
    }
    this.teardownHandle = this.scheduler.setTimeout(() => {
      this.teardownHandle = undefined;
      // The barge-in audio has faded (P1-T08). Go back to hearing the user unless the
      // interjection already resolved into its own turn.
      if (this.current === 'interrupted') {
        this.setState('listening');
      }
    }, this.fadeOutMs);
  }

  private clearTimers(): void {
    this.clearIdleTimer();
    if (this.teardownHandle !== undefined) {
      this.scheduler?.clearTimeout(this.teardownHandle);
      this.teardownHandle = undefined;
    }
  }
}
