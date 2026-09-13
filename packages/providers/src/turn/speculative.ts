import type { SpeculativeRecognition } from '@latentpresence/core';
import type { AudioChunk, STTProvider, SttResult } from '@latentpresence/protocol';
import { isAborted } from '../stt/signal';

/**
 * Turn any `STTProvider` into `TurnDetector`'s speculative recogniser (ADR-21).
 *
 * **This exists because the obvious wiring does nothing.** `transcribe` is an async
 * generator, and a generator's body does not run until something iterates it. Handing
 * `(audio, signal) => stt.transcribe(...)` to the detector returns an iterable that sits
 * idle until the turn ends and a consumer finally reads it — the overlap is silently
 * gone, the pipeline is 40 ms over budget again, and every test that only checks the
 * transcript still passes. This starts consuming at once.
 *
 * Resolves to the final result, or null when the candidate was cancelled — which, per
 * `BrowserSTTProvider`, yields nothing at all. Never rejects on cancellation.
 */
export function speculativeTranscription(stt: STTProvider): SpeculativeRecognition<Promise<SttResult | null>> {
  return (audio, signal) => {
    const consume = async (): Promise<SttResult | null> => {
      let final: SttResult | null = null;
      for await (const result of stt.transcribe(once(audio), { signal })) {
        if (result.isFinal) final = result;
      }
      return isAborted(signal) ? null : final;
    };
    const running = consume();
    // A cancelled candidate's failure is nobody's business; a kept one's is the consumer's,
    // who awaits this promise from `turn-end`. Mark it handled so an abandoned candidate
    // does not surface as an unhandled rejection.
    running.catch(() => undefined);
    return running;
  };
}

async function* once(chunk: AudioChunk): AsyncIterable<AudioChunk> {
  yield chunk;
}
