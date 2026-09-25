import { FaceAffectReader, type FaceParams, type FaceReading } from '@latentpresence/core';

/**
 * Scoring the generated face set (P3-T06) the way the reader meets a person: a few seconds
 * of their resting face, then the expression held, at 10 frames a second. Pure, so the
 * blendshapes can be read once in the browser and the heuristic re-scored as often as
 * tuning needs.
 */

export interface FaceSample {
  readonly person: number;
  readonly label: string;
  readonly blendshapes: Readonly<Record<string, number>> | null;
}

export interface FaceScoreRow {
  readonly person: number;
  readonly expected: string;
  readonly got: string;
  readonly reading: FaceReading | null;
}

export function readHeld(rest: Readonly<Record<string, number>>, face: Readonly<Record<string, number>>, params: Partial<FaceParams> = {}): FaceReading | null {
  const reader = new FaceAffectReader(params);
  for (let t = 0; t < 4000; t += 100) reader.push(rest, t);
  let reading: FaceReading | null = null;
  for (let t = 4000; t < 5500; t += 100) reading = reader.push(face, t);
  return reading;
}

/** Every sample against its own person's neutral one; a person with no face found in neutral is skipped. */
export function scoreFaceSet(samples: readonly FaceSample[], params: Partial<FaceParams> = {}): FaceScoreRow[] {
  const rows: FaceScoreRow[] = [];
  for (const sample of samples) {
    const rest = samples.find((other) => other.person === sample.person && other.label === 'neutral')?.blendshapes;
    if (rest === null || rest === undefined) continue;
    const reading = sample.blendshapes === null ? null : readHeld(rest, sample.blendshapes, params);
    rows.push({ person: sample.person, expected: sample.label, got: reading?.label ?? 'no face', reading });
  }
  return rows;
}
