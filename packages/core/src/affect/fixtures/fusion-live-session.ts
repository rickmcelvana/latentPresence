import type { FusionRecording } from '../fusion';

/**
 * A real session's fusion inputs (P3-T07): five typed turns on `/chat?affect` against
 * `glm-5.2:cloud`, 2026-09-25, copied with the overlay's **Copy recording**. Text only (the
 * Browser pane has no camera or microphone); the model tagged four of the five turns and
 * skipped the angry one, where the surface heuristic's "surprised" stood. Kept exactly as
 * copied: it is the evidence that a recording from the product replays.
 */
export const FUSION_LIVE_SESSION: FusionRecording = {
  version: 1,
  inputs: [
    { kind: 'turn', at: 1790349085116, text: 'hey! finally friday 😄' },
    { kind: 'tag', at: 1790349088928, reading: { channel: 'text', label: 'happy', valence: 0.7, arousal: 0.4, confidence: 0.7 } },
    { kind: 'turn', at: 1790349090304, text: 'so the landlord is selling the flat and we have to be out by november' },
    { kind: 'tag', at: 1790349094715, reading: { channel: 'text', label: 'sad', valence: -0.6, arousal: -0.4, confidence: 0.7 } },
    { kind: 'turn', at: 1790349095996, text: 'and he KNEW when we signed. unbelievable!!' },
    { kind: 'turn', at: 1790349102205, text: 'sorry. I just really liked living there' },
    { kind: 'tag', at: 1790349107751, reading: { channel: 'text', label: 'sad', valence: -0.6, arousal: -0.4, confidence: 0.7 } },
    { kind: 'turn', at: 1790349108912, text: 'anyway. thanks for listening, it helps :)' },
    { kind: 'tag', at: 1790349112668, reading: { channel: 'text', label: 'neutral', valence: 0, arousal: 0, confidence: 0.7 } },
  ],
};
