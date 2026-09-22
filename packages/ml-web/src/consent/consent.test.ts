import type { ModelDescriptor } from '@latentpresence/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConsentRequiredError, ModelConsent, requireConsent } from './consent';

/** A `Pick<Storage, ...>` backed by a plain `Map`, matching `apps/web/src/settings/vault.test.ts`. */
function memoryStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  const backing = new Map<string, string>();
  return {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => {
      backing.set(key, value);
    },
    removeItem: (key: string) => {
      backing.delete(key);
    },
  };
}

/** A `Storage` that throws on every call, for the private-window case. */
function brokenStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  return {
    getItem: () => {
      throw new Error('storage disabled');
    },
    setItem: () => {
      throw new Error('storage disabled');
    },
    removeItem: () => {
      throw new Error('storage disabled');
    },
  };
}

function descriptor(id: string, overrides: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return { id, label: id, sizeBytes: 1_000_000, licence: 'MIT', sourceUrl: 'https://example.com', ...overrides };
}

const Q8 = descriptor('onnx-community/Kokoro-82M-v1.0-ONNX:q8');
const FP32 = descriptor('onnx-community/Kokoro-82M-v1.0-ONNX:fp32');

let consent: ModelConsent;

beforeEach(() => {
  consent = new ModelConsent(memoryStorage());
});

describe('ModelConsent', () => {
  it('has nothing granted to start with', () => {
    expect(consent.has([Q8])).toBe(false);
    expect(consent.granted()).toEqual([]);
  });

  it('grants exactly the ids handed to it', () => {
    consent.grant([Q8]);
    expect(consent.has([Q8])).toBe(true);
    expect(consent.granted()).toEqual([Q8.id]);
  });

  it('granting one precision does not grant a different precision of the same model', () => {
    consent.grant([Q8]);
    expect(consent.has([FP32])).toBe(false);
  });

  it('accumulates across calls rather than replacing', () => {
    consent.grant([Q8]);
    consent.grant([FP32]);
    expect(consent.has([Q8, FP32])).toBe(true);
  });

  it('has() requires every descriptor handed to it, not just one', () => {
    consent.grant([Q8]);
    expect(consent.has([Q8, FP32])).toBe(false);
  });

  it('revoke clears everything', () => {
    consent.grant([Q8, FP32]);
    consent.revoke();
    expect(consent.has([Q8])).toBe(false);
    expect(consent.granted()).toEqual([]);
  });

  it('a broken Storage degrades to "nothing granted" rather than throwing', () => {
    const broken = new ModelConsent(brokenStorage());
    expect(() => broken.has([Q8])).not.toThrow();
    expect(broken.has([Q8])).toBe(false);
    expect(() => broken.grant([Q8])).not.toThrow();
    expect(() => broken.revoke()).not.toThrow();
  });
});

describe('requireConsent', () => {
  it('passes silently once everything asked for is granted', () => {
    consent.grant([Q8, FP32]);
    expect(() => requireConsent(consent, [Q8, FP32])).not.toThrow();
  });

  it('throws a ConsentRequiredError naming every ungranted model', () => {
    consent.grant([Q8]);
    let caught: unknown;
    try {
      requireConsent(consent, [Q8, FP32]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConsentRequiredError);
    expect((caught as ConsentRequiredError).descriptors).toEqual([FP32]);
    expect((caught as Error).message).toContain(FP32.label);
    expect((caught as Error).message).not.toContain(Q8.label);
  });

  it('throws before granting anything itself', () => {
    expect(() => requireConsent(consent, [Q8])).toThrow(ConsentRequiredError);
    expect(consent.has([Q8])).toBe(false);
  });
});
