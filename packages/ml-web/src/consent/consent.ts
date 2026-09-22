import type { ModelDescriptor } from '@latentpresence/protocol';

/**
 * Model download consent (P1-T13): CLAUDE.md's "nothing downloads without the consent
 * screen (size, licence, source)" and ADR-09, as data rather than a screen.
 *
 * Consent is per `ModelDescriptor.id`, which already encodes precision
 * (`onnx-community/Kokoro-82M-v1.0-ONNX:fp32`) — **agreeing to the 92 MB `q8` build must
 * not agree to the 325 MB `fp32` one**, so nothing here ever grants an id it was not
 * handed.
 *
 * Backed by an injected `Storage` (the `apps/web/src/settings` pattern: `Vault`, `loadSettings`),
 * so a test runs against a plain object and the real one is `window.localStorage`, built by
 * the caller. This module has no DOM in it at all — not even a default that touches
 * `window` — because it is imported from `packages/ml-web/src/consent/gated-workers.ts`,
 * which is imported from the dev harness on the main thread.
 *
 * A `Storage` that throws on every call — a private window with storage blocked outright —
 * degrades to "nothing granted" rather than crashing the very screen trying to ask.
 */

const STORAGE_KEY = 'latentpresence.consent.v1';

export class ModelConsent {
  private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

  constructor(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>) {
    this.storage = storage;
  }

  private readAll(): string[] {
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (raw === null) return [];
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
    } catch {
      return [];
    }
  }

  private writeAll(ids: readonly string[]): void {
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(ids));
    } catch {
      // A write that fails leaves consent exactly as it was; the next `grant` tries again
      // rather than pretending this one worked.
    }
  }

  /** True when every descriptor's id has already been granted. */
  has(descriptors: readonly ModelDescriptor[]): boolean {
    const granted = new Set(this.readAll());
    return descriptors.every((descriptor) => granted.has(descriptor.id));
  }

  /** Record consent for exactly these ids, alongside whatever was already granted. */
  grant(descriptors: readonly ModelDescriptor[]): void {
    const granted = new Set(this.readAll());
    for (const descriptor of descriptors) granted.add(descriptor.id);
    this.writeAll([...granted]);
  }

  /** Withdraw every consent this browser has recorded. */
  revoke(): void {
    try {
      this.storage.removeItem(STORAGE_KEY);
    } catch {
      // Nothing to do differently: storage that cannot be written cannot be cleared either.
    }
  }

  /** Every granted id, for the settings screen and for `requireConsent` below. */
  granted(): readonly string[] {
    return this.readAll();
  }
}

/**
 * Thrown by `requireConsent`, naming the models that were not agreed to. A distinct class
 * rather than a message pattern, so a caller can catch it by `instanceof` and show the
 * consent screen instead of a bare error.
 */
export class ConsentRequiredError extends Error {
  readonly descriptors: readonly ModelDescriptor[];

  constructor(descriptors: readonly ModelDescriptor[]) {
    super(`consent required for: ${descriptors.map((descriptor) => descriptor.label).join(', ')}`);
    this.name = 'ConsentRequiredError';
    this.descriptors = descriptors;
  }
}

/**
 * The structural half of "no fetch before consent" (`docs/SURFACE.md`, "What actually
 * downloads weights", read for this task): every worker-creating entry point in
 * `gated-workers.ts` calls this *first*, so an ungranted model is refused before a worker
 * exists to fetch it — not wrapped around a `fetch` call that neither download path
 * actually goes through.
 */
export function requireConsent(consent: ModelConsent, descriptors: readonly ModelDescriptor[]): void {
  const granted = new Set(consent.granted());
  const missing = descriptors.filter((descriptor) => !granted.has(descriptor.id));
  if (missing.length > 0) throw new ConsentRequiredError(missing);
}
