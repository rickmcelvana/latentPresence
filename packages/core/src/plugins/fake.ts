import type { JsonValue, MemoryStore } from '@latentpresence/protocol';
import { seededRandom } from '../idle/planner';
import { FakeMemoryStore } from '../memory/fake-store';
import type { PluginDisplay, PluginHost } from './runtime';

/** A `PluginHost` for tests (P10-T02): a fake store, seeded draws (the idle planner's mulberry32, never the app's randomness), and every layout it was asked to show. */
export class FakePluginHost implements PluginHost {
  readonly store: MemoryStore;
  readonly characterId: string;
  readonly random: () => number;
  readonly settings: Readonly<Record<string, JsonValue>>;
  readonly shown: PluginDisplay[] = [];
  readonly now: () => Date;

  constructor(options: { readonly store?: MemoryStore; readonly characterId?: string; readonly seed?: number; readonly settings?: Readonly<Record<string, JsonValue>>; readonly now?: () => Date } = {}) {
    this.store = options.store ?? new FakeMemoryStore();
    this.characterId = options.characterId ?? 'alice';
    this.random = seededRandom(options.seed ?? 1);
    this.settings = options.settings ?? {};
    this.now = options.now ?? (() => new Date('2026-11-06T12:00:00Z'));
  }

  readonly show = (display: PluginDisplay): void => {
    this.shown.push(display);
  };
}
