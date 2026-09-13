import type { PlaybackRequest, PlaybackResponse } from './messages';
import { PLAYBACK_PROCESSOR } from './messages';
import { PlaybackRenderer } from './renderer';

/**
 * The playback queue on the audio thread (P1-T08). Everything it does is `PlaybackRenderer`;
 * this file only moves messages and stamps times.
 *
 * Loaded with `?worker&url`, which Vite bundles into its own chunk in both dev and a
 * production build — verified 2026-09-13 in the Browser pane, `docs/SURFACE.md`.
 */

// AudioWorkletGlobalScope is not in TypeScript's DOM lib.
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void;
declare const currentTime: number;
declare const sampleRate: number;

class PlaybackProcessor extends AudioWorkletProcessor {
  private readonly renderer = new PlaybackRenderer();
  private recording = false;

  constructor() {
    super();
    this.port.addEventListener('message', (event: MessageEvent<PlaybackRequest>): void => {
      const message = event.data;
      switch (message.type) {
        case 'enqueue':
          this.renderer.enqueue(message.id, message.samples);
          return;
        case 'gain':
          this.renderer.setGain(message.target, message.frames);
          return;
        case 'fade':
          this.renderer.fade(message.frames);
          return;
        case 'record':
          this.recording = message.on;
          return;
      }
    });
    // A MessagePort listened to with addEventListener delivers nothing until started.
    this.port.start();
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const channels = outputs[0];
    const out = channels?.[0];
    if (channels === undefined || out === undefined) return true;

    const report = this.renderer.render(out);
    for (let c = 1; c < channels.length; c += 1) channels[c]?.set(out);

    const post = (message: PlaybackResponse, transfer: Transferable[] = []): void => {
      this.port.postMessage(message, transfer);
    };
    for (const { id, offset } of report.started) post({ type: 'started', id, time: currentTime + offset / sampleRate });
    for (const { id, offset } of report.ended) post({ type: 'ended', id, time: currentTime + offset / sampleRate });
    if (report.faded !== null) post({ type: 'faded', time: currentTime + report.faded / sampleRate });
    if (this.recording) {
      const samples = out.slice();
      post({ type: 'recorded', samples, time: currentTime }, [samples.buffer]);
    }
    // Returning false would remove the node for good, silently. Never.
    return true;
  }
}

registerProcessor(PLAYBACK_PROCESSOR, PlaybackProcessor);
