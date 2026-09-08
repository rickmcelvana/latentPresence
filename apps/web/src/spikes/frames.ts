/**
 * Frame geometry, in its own module so the main thread can know the frame size without
 * importing the VAD worker.
 *
 * Importing a worker module from the main thread also evaluates its imports there: with
 * this constant living in `vad.worker.ts`, opening the page pulled ONNX Runtime into the
 * main bundle before the consent screen had been answered. No weights were fetched, so
 * ADR-09 was not broken, but a megabyte of runtime for a screen that only shows a table
 * is not the behaviour the screen is meant to demonstrate.
 */

/** Silero v5 wants exactly this many samples per call at 16 kHz. */
export const FRAME_SAMPLES = 512;

export const SAMPLE_RATE = 16_000;
