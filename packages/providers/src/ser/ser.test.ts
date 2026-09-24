import { describe, expect, it } from 'vitest';
import { AffectReadingSchema } from '@latentpresence/protocol';
import type { SerRequest, SerResponse, SerWorkerPort } from '@latentpresence/ml-web';
import { SpeechEmotionReader, readingFromProbabilities } from './speech-emotion';

// BASE_LABELS order: angry, disgusted, fearful, happy, neutral, other, sad, surprised, unknown.
const probs = (entries: Partial<Record<number, number>>): number[] => Array.from({ length: 9 }, (_, k) => entries[k] ?? 0);

describe('readingFromProbabilities', () => {
  it('names the strongest meaningful class and places it in valence and arousal', () => {
    const reading = readingFromProbabilities(probs({ 6: 0.8, 4: 0.2 }));
    expect(reading).toMatchObject({ channel: 'voice', label: 'sad' });
    expect(reading.confidence).toBeCloseTo(0.8, 10);
    expect(reading.valence).toBeLessThan(-0.4);
    expect(AffectReadingSchema.safeParse(reading).success).toBe(true);
  });

  it('reads other and unknown as the model not knowing, not as a feeling', () => {
    // live:ser: the base model called a neutral Kokoro sentence `unknown` at 0.68.
    expect(readingFromProbabilities(probs({ 8: 0.68, 4: 0.25, 3: 0.07 }))).toMatchObject({ label: 'neutral', confidence: 0 });
    const half = readingFromProbabilities(probs({ 8: 0.5, 0: 0.5 }));
    expect(half.label).toBe('angry');
    expect(half.confidence).toBeCloseTo(0.5, 10);
  });

  it('lands a mixed reading between its classes', () => {
    expect(Math.abs(readingFromProbabilities(probs({ 3: 0.5, 6: 0.5 })).valence)).toBeLessThan(0.1);
  });
});

/** A worker that answers from a script. */
function fakePort(answer: (request: SerRequest) => SerResponse | null) {
  const listeners = new Set<(message: SerResponse) => void>();
  const posted: SerRequest[] = [];
  let terminated = false;
  const port: SerWorkerPort = {
    post(message) {
      posted.push(message);
      const reply = answer(message);
      if (reply !== null) queueMicrotask(() => listeners.forEach((listener) => listener(reply)));
    },
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    terminate() {
      terminated = true;
    },
  };
  return { port, posted, terminated: () => terminated };
}

describe('SpeechEmotionReader', () => {
  it('loads the distill on wasm by default, and base on WebGPU when asked (ADR-33)', () => {
    expect(new SpeechEmotionReader({ createWorker: () => fakePort(() => null).port })).toMatchObject({ model: 'distill', backend: 'wasm' });
    expect(new SpeechEmotionReader({ createWorker: () => fakePort(() => null).port, model: 'base' })).toMatchObject({ backend: 'webgpu' });
  });

  it('loads once, then answers each segment with a reading', async () => {
    const fake = fakePort((request) => {
      if (request.type === 'load') return { type: 'ready', loadMs: 5, model: request.model, backend: request.backend };
      return { type: 'result', requestId: request.requestId, probabilities: probs({ 3: 0.9, 4: 0.1 }), inferenceMs: 42, seconds: 1 };
    });
    let created = 0;
    const reader = new SpeechEmotionReader({
      createWorker: () => {
        created += 1;
        return fake.port;
      },
    });
    const first = await reader.read(new Float32Array(16_000));
    const second = await reader.read(new Float32Array(16_000));
    expect(created).toBe(1);
    expect(fake.posted.filter((message) => message.type === 'load')).toHaveLength(1);
    expect(first).toMatchObject({ label: 'happy', inferenceMs: 42 });
    expect(second.label).toBe('happy');
  });

  it('fails loudly when the model will not load', async () => {
    const fake = fakePort((request) => (request.type === 'load' ? { type: 'error', requestId: null, message: 'no adapter' } : null));
    await expect(new SpeechEmotionReader({ createWorker: () => fake.port }).load()).rejects.toThrow('voice emotion: no adapter');
  });

  it('rejects what is pending when terminated', async () => {
    const fake = fakePort((request) => (request.type === 'load' ? { type: 'ready', loadMs: 1, model: 'base', backend: 'webgpu' } : null));
    const reader = new SpeechEmotionReader({ createWorker: () => fake.port });
    const pending = reader.read(new Float32Array(10));
    await reader.load();
    await Promise.resolve();
    reader.terminate();
    await expect(pending).rejects.toThrow('terminated');
    expect(fake.terminated()).toBe(true);
  });
});
