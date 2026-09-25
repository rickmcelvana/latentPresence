/**
 * Writes `src/affect/fixtures/fusion-session.ts` (P3-T07): a session's fusion inputs,
 * scripted here so the fixture can be rebuilt. It exercises every input kind — face frames
 * with the user speaking and not, voice readings (one the model could not tell), typed and
 * spoken turns, and the model's `[user:x]` agreeing and correcting.
 *
 *   pnpm --filter @latentpresence/core exec vite-node scripts/make-fusion-fixture.ts
 */
import { writeFileSync } from 'node:fs';
import type { AffectReading } from '@latentpresence/protocol';
import { UserAffectFusion, recordFusion } from '../src/affect/fusion';
import { USER_EMOTION_VA } from '../src/affect/user-text';

const T0 = Date.parse('2026-09-25T10:00:00Z');
const r = (channel: AffectReading['channel'], label: AffectReading['label'], confidence: number): AffectReading => ({
  channel,
  label,
  confidence,
  ...USER_EMOTION_VA[label],
});

const fusion = new UserAffectFusion();
const recorder = recordFusion(fusion);
let at = T0;
const faceFor = (ms: number, label: AffectReading['label'], confidence: number): void => {
  for (const end = at + ms; at < end; at += 500) fusion.observe('face', r('face', label, confidence), at);
};

// A cheerful start, typed.
faceFor(3000, 'happy', 0.45);
fusion.turn('hi!! finally friday 😄', at);
at += 900;
fusion.tag(r('text', 'happy', 0.7), at);
// Spoken: the voice model cannot tell; the face is talking.
faceFor(2000, 'neutral', 0.3);
fusion.setSpeaking(true, at);
faceFor(2500, 'happy', 0.4);
fusion.setSpeaking(false, at);
fusion.observe('voice', r('voice', 'neutral', 0.43), at);
fusion.turn('so I have news about the flat', at);
at += 1100;
fusion.tag(r('text', 'neutral', 0.7), at);
// The news is bad: no surface cue, the model reads it, the face follows.
faceFor(20_000, 'neutral', 0.3);
fusion.setSpeaking(true, at);
faceFor(3000, 'sad', 0.35);
fusion.setSpeaking(false, at);
fusion.observe('voice', r('voice', 'sad', 0.55), at);
fusion.turn('the landlord is selling it and we have to be out by november', at);
at += 1000;
fusion.tag(r('text', 'sad', 0.7), at);
faceFor(4000, 'sad', 0.4);
// Then angry, typed, on the surface.
fusion.turn('and he KNEW when we signed. unbelievable!!', at);
at += 800;
fusion.tag(r('text', 'angry', 0.7), at);

const header =
  "import type { FusionRecording } from '../fusion';\n\n" +
  '/** A session of fusion inputs (P3-T07), written by `scripts/make-fusion-fixture.ts`. Do not edit by hand. */\n';
writeFileSync(
  new URL('../src/affect/fixtures/fusion-session.ts', import.meta.url),
  `${header}export const FUSION_SESSION: FusionRecording = ${JSON.stringify(recorder.recording(), null, 1)};\n`,
);
console.log(`${recorder.recording().inputs.length} inputs`);
