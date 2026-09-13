import { describe, expect, it } from 'vitest';
import {
  ASR_MODELS,
  ASR_SAMPLE_RATE,
  asrModel,
  combinationBlocker,
  hasRecordedAsrSize,
  isSupportedCombination,
  type AsrDevice,
  type AsrDtype,
  type AsrModelKey,
} from './messages';

const MODELS = Object.keys(ASR_MODELS) as AsrModelKey[];
const DTYPES: AsrDtype[] = ['fp32', 'fp16', 'q8', 'q4', 'q4f16'];

describe('the download size table', () => {
  /**
   * The two rows that were actually downloaded into an empty cache on 2026-09-12. They are
   * pinned literally because the rest of the table is arithmetic hanging off the same
   * constants: if a config file changes upstream, these are what catch it, and they are
   * the only numbers here that were not derived.
   */
  it('matches what was measured', () => {
    expect(ASR_MODELS['moonshine-tiny'].bytes.q8).toBe(32_079_632);
    expect(ASR_MODELS['whisper-base'].bytes.q8).toBe(79_641_437);
  });

  it('never quotes a size it does not have', () => {
    for (const model of MODELS) {
      for (const dtype of DTYPES) {
        if (hasRecordedAsrSize(model, dtype)) {
          expect(asrModel(model, dtype).sizeBytes).toBeGreaterThan(0);
        } else {
          // ADR-09's promise is that the number shown is the number downloaded. Throwing
          // is the only honest answer when there is no number.
          expect(() => asrModel(model, dtype)).toThrow(/no recorded download size/u);
        }
      }
    }
  });

  it('has no size that is implausible for its model', () => {
    for (const model of MODELS) {
      const spec = ASR_MODELS[model];
      for (const dtype of DTYPES) {
        const bytes = spec.bytes[dtype];
        if (bytes === undefined) continue;
        // A transposed digit or a missing graph shows up here and nowhere else until a
        // user watches a progress bar overshoot.
        expect(bytes).toBeGreaterThan(20_000_000);
        expect(bytes).toBeLessThan(400_000_000);
        if (dtype !== 'fp32') expect(bytes).toBeLessThan(spec.bytes.fp32 ?? Infinity);
      }
    }
  });

  it('describes each model well enough to consent to it', () => {
    for (const model of MODELS) {
      const descriptor = asrModel(model, 'fp32');
      expect(descriptor.sourceUrl).toBe(`https://huggingface.co/${ASR_MODELS[model].modelId}`);
      expect(descriptor.licence).not.toBe('');
      expect(descriptor.id).toContain('fp32');
    }
  });
});

describe('device and precision combinations', () => {
  /**
   * ADR-20: transformers.js's WebGPU q8 path returned the same fluent sentence for every
   * utterance, with no error. This is the guard that keeps that combination unreachable,
   * and it is worth a test because the failure it prevents is invisible — a wrong
   * transcript reaches the transcript panel, the memory store and the model's next turn
   * with nothing anywhere reporting a problem.
   */
  it('refuses every quantised precision on WebGPU', () => {
    for (const dtype of ['q8', 'q4', 'q4f16'] as AsrDtype[]) {
      expect(isSupportedCombination('webgpu', dtype)).toBe(false);
      expect(combinationBlocker('webgpu', dtype)).toContain('ADR-20');
    }
  });

  it('allows full and half precision on WebGPU', () => {
    for (const dtype of ['fp32', 'fp16'] as AsrDtype[]) {
      expect(isSupportedCombination('webgpu', dtype)).toBe(true);
      expect(combinationBlocker('webgpu', dtype)).toBeNull();
    }
  });

  it('allows everything on wasm, which is where quantisation is the point', () => {
    for (const dtype of DTYPES) {
      expect(isSupportedCombination('wasm', dtype)).toBe(true);
    }
  });

  it('names the precision it refused, so a settings screen can say which', () => {
    const blocker = combinationBlocker('webgpu', 'q8');
    expect(blocker).toContain('q8');
  });

  it('covers every device in the union', () => {
    const devices: AsrDevice[] = ['webgpu', 'wasm'];
    for (const device of devices) expect(typeof isSupportedCombination(device, 'fp32')).toBe('boolean');
  });
});

describe('model capabilities', () => {
  it('says Moonshine has no word timings and one language', () => {
    // Read out of `_call_moonshine` in transformers.js, which returns `{ text }` and
    // nothing else. Claiming otherwise would have the affect engine wait for timings
    // that never arrive.
    for (const model of ['moonshine-tiny', 'moonshine-base'] as AsrModelKey[]) {
      expect(ASR_MODELS[model].wordTimestamps).toBe(false);
      expect(ASR_MODELS[model].languages).toEqual(['en']);
    }
  });

  it('says Whisper has word timings, and says nothing about its languages', () => {
    expect(ASR_MODELS['whisper-base'].wordTimestamps).toBe(true);
    // Empty means "did not say" per `SttCapabilities.languages` — not "no languages".
    expect(ASR_MODELS['whisper-base'].languages).toEqual([]);
    expect(ASR_MODELS['whisper-tiny-en'].languages).toEqual(['en']);
  });
});

it('expects 16 kHz, which is what every model here was trained on', () => {
  expect(ASR_SAMPLE_RATE).toBe(16_000);
});
