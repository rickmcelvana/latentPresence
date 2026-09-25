import { FaceAffectReader, type FaceReading } from '@latentpresence/core';
import { createGatedFaceWorker, faceModels, type FaceDelegate } from '@latentpresence/ml-web';
import type { ModelDescriptor } from '@latentpresence/protocol';
import { FaceExpressionReader } from '@latentpresence/providers';
import type { ModelConsent } from '@latentpresence/ml-web/consent';

/**
 * Reading the user's face on `/chat` (P3-T06), loaded on the first click of *Read my face*
 * and never before: it imports MediaPipe's worker, and a person who never turns it on
 * should not fetch a byte of it.
 *
 * A pump, not a stream: every `FACE_SAMPLE_MS` it takes one frame from the camera's
 * `<video>` as an `ImageBitmap`, **transfers** it to the worker, which closes it once read,
 * and hands the blendshapes to `FaceAffectReader`. One frame in flight at a time — a slow
 * machine reads less often rather than queueing frames. Nothing keeps a frame: the bitmap
 * is gone the moment it is sent, and the worker's `readFrame` closes it whatever happens.
 */

/** 10 frames a second: a face changes over hundreds of milliseconds, and each frame costs a model run. */
export const FACE_SAMPLE_MS = 100;

export interface FaceReadingStatus {
  /** The latest reading, null when no face is seen. */
  readonly reading: FaceReading | null;
  readonly delegate: FaceDelegate;
  /** Median model time over the last few frames. */
  readonly inferenceMs: number;
}

export interface FaceReadingHandle {
  stop(): void;
}

export interface FaceReadingOptions {
  readonly consent: ModelConsent;
  readonly video: HTMLVideoElement;
  readonly onStatus: (status: FaceReadingStatus) => void;
  readonly onError: (message: string) => void;
}

export function faceReadingModels(): ModelDescriptor[] {
  return faceModels();
}

function median(values: readonly number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** Load the landmarker (behind consent) and start reading frames from `video`. */
export async function startFaceReading({ consent, video, onStatus, onError }: FaceReadingOptions): Promise<FaceReadingHandle> {
  // CPU first: on the dev box both delegates took ~24 ms a frame (`/dev/face`, 2026-09-25),
  // and the GPU is already drawing her and, in a call, running Kokoro.
  const reader = new FaceExpressionReader({ createWorker: () => createGatedFaceWorker(consent), delegates: ['CPU', 'GPU'] });
  const face = new FaceAffectReader();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const times: number[] = [];
  let lastTimestamp = 0;

  const stop = (): void => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    reader.terminate();
  };

  let delegate: FaceDelegate;
  try {
    delegate = await reader.load();
  } catch (error) {
    stop();
    throw error;
  }

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const started = performance.now();
    try {
      // A video that has no frame yet (or a hidden tab's paused one) is skipped, not read.
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0) {
        const frame = await createImageBitmap(video);
        // MediaPipe's video mode wants timestamps that strictly increase.
        const timestamp = Math.max(lastTimestamp + 1, Math.round(performance.now()));
        lastTimestamp = timestamp;
        const result = await reader.read(frame, timestamp);
        if (stopped) return;
        times.push(result.inferenceMs);
        if (times.length > 20) times.shift();
        onStatus({ reading: face.push(result.blendshapes, performance.now()), delegate, inferenceMs: median(times) });
      }
    } catch (error) {
      if (stopped) return;
      stop();
      onError(error instanceof Error ? error.message : String(error));
      return;
    }
    timer = setTimeout(() => void tick(), Math.max(0, FACE_SAMPLE_MS - (performance.now() - started)));
  };
  void tick();
  return { stop };
}
