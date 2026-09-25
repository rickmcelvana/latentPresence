import { asrModel } from '../asr';
import { kokoroModel } from '../kokoro';
import { sileroVadModel, smartTurnModel } from '../turn';
import { faceModels } from '../face';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsentRequiredError, ModelConsent } from './consent';
import { createGatedAsrWorker, createGatedFaceWorker, createGatedKokoroWorker, createGatedSmartTurnWorker, createGatedVadWorker } from './gated-workers';

/**
 * The structural gate, which is P1-T13's done-when: with no consent recorded, each of the
 * four entry points throws *before* the real `create*Worker` runs — so `new Worker(...)`
 * never happens, and neither can anything that only runs inside that worker thread
 * (`InferenceSession.create`, `pipeline()`, `KokoroTTS.from_pretrained`, all of which only
 * this repo's worker files call, never this one). A `fetch` spy is asserted too, though it
 * proves less on its own: neither download path in `docs/SURFACE.md` goes through a
 * `fetch` this module owns, which is the whole reason the gate lives here and not around
 * one.
 */

// `vi.mock` factories are hoisted above every import in this file, so the spies they
// close over must be too — `vi.hoisted` is what makes that legal rather than a
// "used before initialization" error.
const { vadPort, smartTurnPort, asrPort, kokoroPort, createVadWorkerSpy, createSmartTurnWorkerSpy, createAsrWorkerSpy, createKokoroWorkerSpy } =
  vi.hoisted(() => {
    const fakeVadPort = { post: vi.fn(), onMessage: vi.fn(), terminate: vi.fn() };
    const fakeSmartTurnPort = { post: vi.fn(), onMessage: vi.fn(), terminate: vi.fn() };
    const fakeAsrPort = { post: vi.fn(), onMessage: vi.fn(), terminate: vi.fn() };
    const fakeKokoroPort = { post: vi.fn(), onMessage: vi.fn(), terminate: vi.fn() };
    return {
      vadPort: fakeVadPort,
      smartTurnPort: fakeSmartTurnPort,
      asrPort: fakeAsrPort,
      kokoroPort: fakeKokoroPort,
      createVadWorkerSpy: vi.fn(() => fakeVadPort),
      createSmartTurnWorkerSpy: vi.fn(() => fakeSmartTurnPort),
      createAsrWorkerSpy: vi.fn(() => fakeAsrPort),
      createKokoroWorkerSpy: vi.fn(() => fakeKokoroPort),
    };
  });

// The concrete modules, not the barrels: the ungated factories are no longer re-exported
// from `../turn`, `../asr` or `../kokoro` — withholding them is what makes bypassing the
// gate a compile error — so `gated-workers.ts` imports them by path and these mocks must
// follow it there. Mocking the barrels would silently miss and run the real thing.
vi.mock('../turn/create-worker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../turn/create-worker')>();
  return { ...actual, createVadWorker: createVadWorkerSpy, createSmartTurnWorker: createSmartTurnWorkerSpy };
});
vi.mock('../asr/create-worker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../asr/create-worker')>();
  return { ...actual, createAsrWorker: createAsrWorkerSpy };
});
const { facePort, createFaceWorkerSpy } = vi.hoisted(() => {
  const fakeFacePort = { post: vi.fn(), onMessage: vi.fn(), terminate: vi.fn() };
  return { facePort: fakeFacePort, createFaceWorkerSpy: vi.fn(() => fakeFacePort) };
});
vi.mock('../face/create-worker', () => ({ createFaceWorker: createFaceWorkerSpy }));
vi.mock('../kokoro/create-worker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../kokoro/create-worker')>();
  return { ...actual, createKokoroWorker: createKokoroWorkerSpy };
});

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

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  for (const spy of [createVadWorkerSpy, createSmartTurnWorkerSpy, createAsrWorkerSpy, createKokoroWorkerSpy, createFaceWorkerSpy]) spy.mockClear();
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
});

describe('createGatedVadWorker', () => {
  it('refuses before constructing anything when consent is missing', () => {
    const consent = new ModelConsent(memoryStorage());
    expect(() => createGatedVadWorker(consent)).toThrow(ConsentRequiredError);
    expect(createVadWorkerSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('builds the worker once Silero is granted', () => {
    const consent = new ModelConsent(memoryStorage());
    consent.grant([sileroVadModel()]);
    expect(createGatedVadWorker(consent)).toBe(vadPort);
    expect(createVadWorkerSpy).toHaveBeenCalledTimes(1);
  });
});

describe('createGatedSmartTurnWorker', () => {
  it('refuses before constructing anything when consent is missing', () => {
    const consent = new ModelConsent(memoryStorage());
    expect(() => createGatedSmartTurnWorker(consent, 'gpu')).toThrow(ConsentRequiredError);
    expect(createSmartTurnWorkerSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('one build being granted does not grant the other', () => {
    const consent = new ModelConsent(memoryStorage());
    consent.grant([smartTurnModel('cpu')]);
    expect(() => createGatedSmartTurnWorker(consent, 'gpu')).toThrow(ConsentRequiredError);
    expect(createSmartTurnWorkerSpy).not.toHaveBeenCalled();
  });

  it('builds the worker once its build is granted', () => {
    const consent = new ModelConsent(memoryStorage());
    consent.grant([smartTurnModel('gpu')]);
    expect(createGatedSmartTurnWorker(consent, 'gpu')).toBe(smartTurnPort);
    expect(createSmartTurnWorkerSpy).toHaveBeenCalledTimes(1);
  });
});

describe('createGatedAsrWorker', () => {
  it('refuses before constructing anything when consent is missing', () => {
    const consent = new ModelConsent(memoryStorage());
    expect(() => createGatedAsrWorker(consent, 'moonshine-tiny', 'fp32')).toThrow(ConsentRequiredError);
    expect(createAsrWorkerSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('builds the worker once that model and precision are granted', () => {
    const consent = new ModelConsent(memoryStorage());
    consent.grant([asrModel('moonshine-tiny', 'fp32')]);
    expect(createGatedAsrWorker(consent, 'moonshine-tiny', 'fp32')).toBe(asrPort);
    expect(createAsrWorkerSpy).toHaveBeenCalledTimes(1);
  });
});

describe('createGatedKokoroWorker', () => {
  it('refuses before constructing anything when consent is missing', () => {
    const consent = new ModelConsent(memoryStorage());
    expect(() => createGatedKokoroWorker(consent, 'fp32')).toThrow(ConsentRequiredError);
    expect(createKokoroWorkerSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('agreeing to q8 does not agree to fp32', () => {
    const consent = new ModelConsent(memoryStorage());
    consent.grant([kokoroModel('q8')]);
    expect(() => createGatedKokoroWorker(consent, 'fp32')).toThrow(ConsentRequiredError);
    expect(createKokoroWorkerSpy).not.toHaveBeenCalled();
  });

  it('builds the worker once that precision is granted', () => {
    const consent = new ModelConsent(memoryStorage());
    consent.grant([kokoroModel('fp32')]);
    expect(createGatedKokoroWorker(consent, 'fp32')).toBe(kokoroPort);
    expect(createKokoroWorkerSpy).toHaveBeenCalledTimes(1);
  });
});

describe('createGatedFaceWorker (P3-T06)', () => {
  it('refuses before constructing anything when consent is missing', () => {
    const consent = new ModelConsent(memoryStorage());
    expect(() => createGatedFaceWorker(consent)).toThrow(ConsentRequiredError);
    expect(createFaceWorkerSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('builds the worker once the landmarker is granted', () => {
    const consent = new ModelConsent(memoryStorage());
    consent.grant(faceModels());
    expect(createGatedFaceWorker(consent)).toBe(facePort);
    expect(createFaceWorkerSpy).toHaveBeenCalledTimes(1);
  });
});
