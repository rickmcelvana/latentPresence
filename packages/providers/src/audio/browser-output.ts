import type { PlaybackEvent, PlaybackPosition, PlaybackSegment, PlaybackSink } from '@latentpresence/core';
import { resample } from '@latentpresence/ml-web';
import type { PlaybackPort, PlaybackResponse } from './messages';

/**
 * The character's voice, through an AudioWorklet (P1-T08). Implements core's `PlaybackSink`
 * over a structural port, so it tests in node against a real `PlaybackRenderer` standing
 * in for the audio thread; `createAudioOutput` builds the real one.
 *
 * **One context for the session, at one rate.** Both TTS providers produce 24 kHz, so the
 * context runs at 24 kHz and the browser resamples to the device. A segment at any other
 * rate is resampled here, once, rather than re-creating the context — Spike A's `Playback`
 * did that and every rate change was a gap. `resample` is linear, which is measured for
 * recognition and not for listening; no provider exercises it today.
 *
 * **Where playback is** is computed on the main thread from the context clock, which is the
 * render clock, against the worklet's stamp for when the segment started. That is exact to
 * a render quantum without a round trip, which is what lets barge-in say what was heard at
 * the moment it commits.
 */

/** −12 dB: clearly yielding, still intelligible if the user was only coughing. */
export const DUCK_GAIN = 0.25;
export const DUCK_MS = 30;
/** Restoring is slower than ducking: a voice that snaps back reads as a jolt. */
export const UNDUCK_MS = 80;

export interface BrowserAudioOutputConfig {
  readonly port: PlaybackPort;
  /** The AudioContext's rate. */
  readonly sampleRate: number;
  /** `AudioContext.currentTime`, in seconds. */
  readonly clock: () => number;
  /** `AudioContext.outputLatency`, in seconds: render to ear. Zero where unreported. */
  readonly outputLatency?: () => number;
}

interface Segment {
  readonly id: number;
  /** Frames at the segment's own rate, and at the context's. */
  readonly frames: number;
  readonly contextFrames: number;
  startedAt: number | null;
  ended: boolean;
}

export class BrowserAudioOutput implements PlaybackSink {
  private readonly config: BrowserAudioOutputConfig;
  private readonly listeners = new Set<(event: PlaybackEvent) => void>();
  private readonly recorders = new Set<(samples: Float32Array, time: number) => void>();
  private readonly segments = new Map<number, Segment>();
  private readonly detach: () => void;
  private nextId = 1;
  private fading: { promise: Promise<void>; resolve: () => void } | null = null;

  constructor(config: BrowserAudioOutputConfig) {
    this.config = config;
    this.detach = config.port.onMessage((message) => this.onMessage(message));
  }

  enqueue(segment: PlaybackSegment): number {
    const id = this.nextId;
    this.nextId += 1;
    const samples =
      segment.sampleRate === this.config.sampleRate
        ? segment.samples
        : resample(segment.samples, segment.sampleRate, this.config.sampleRate);
    this.segments.set(id, {
      id,
      frames: segment.samples.length,
      contextFrames: samples.length,
      startedAt: null,
      ended: false,
    });
    this.config.port.post({ type: 'enqueue', id, samples }, [samples.buffer]);
    return id;
  }

  duck(): void {
    this.config.port.post({ type: 'gain', target: DUCK_GAIN, frames: this.frames(DUCK_MS) });
  }

  unduck(): void {
    this.config.port.post({ type: 'gain', target: 1, frames: this.frames(UNDUCK_MS) });
  }

  fadeOut(ms: number): Promise<void> {
    if (this.fading !== null) return this.fading.promise;
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    this.fading = { promise, resolve };
    this.config.port.post({ type: 'fade', frames: this.frames(ms) });
    return promise;
  }

  position(): PlaybackPosition | null {
    let current: Segment | null = null;
    for (const segment of this.segments.values()) {
      if (segment.startedAt !== null && !segment.ended) {
        if (current === null || (current.startedAt ?? 0) < segment.startedAt) current = segment;
      }
    }
    if (current === null || current.startedAt === null) return null;
    const rendered = Math.round((this.config.clock() - current.startedAt) * this.config.sampleRate);
    const contextFrame = Math.min(Math.max(rendered, 0), current.contextFrames);
    return { id: current.id, frame: Math.round((contextFrame * current.frames) / current.contextFrames) };
  }

  subscribe(listener: (event: PlaybackEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Receive every block the worklet renders — the exact samples sent to the device, after
   * gain and clamp. For measuring the output (clicks); costs a copy per quantum while on.
   */
  record(listener: (samples: Float32Array, time: number) => void): () => void {
    this.recorders.add(listener);
    if (this.recorders.size === 1) this.config.port.post({ type: 'record', on: true });
    return () => {
      this.recorders.delete(listener);
      if (this.recorders.size === 0) this.config.port.post({ type: 'record', on: false });
    };
  }

  dispose(): void {
    this.detach();
    this.listeners.clear();
    this.fading?.resolve();
    this.fading = null;
  }

  private frames(ms: number): number {
    return Math.max(0, Math.round((ms / 1000) * this.config.sampleRate));
  }

  private onMessage(message: PlaybackResponse): void {
    const latency = this.config.outputLatency?.() ?? 0;
    switch (message.type) {
      case 'started': {
        const segment = this.segments.get(message.id);
        if (segment === undefined) return;
        segment.startedAt = message.time;
        this.emit({ type: 'started', id: message.id, at: (message.time + latency) * 1000 });
        return;
      }
      case 'ended': {
        const segment = this.segments.get(message.id);
        if (segment === undefined) return;
        segment.ended = true;
        this.segments.delete(message.id);
        this.emit({ type: 'ended', id: message.id, at: (message.time + latency) * 1000 });
        return;
      }
      case 'faded': {
        const fading = this.fading;
        this.fading = null;
        fading?.resolve();
        return;
      }
      case 'recorded':
        for (const recorder of this.recorders) recorder(message.samples, message.time);
        return;
    }
  }

  private emit(event: PlaybackEvent): void {
    // A copy, so a listener that unsubscribes while handling an event does not disturb delivery.
    for (const listener of Array.from(this.listeners)) listener(event);
  }
}
