import { median } from './metrics';

/**
 * The timing and accuracy model for Spike D.
 *
 * Same discipline as `metrics.ts`: one monotonic clock, and a candidate missing a mark is
 * reported as incomplete rather than turned into a plausible number. The addition here is
 * that latency alone cannot answer this spike's question — a model that always says
 * "finished" is instant and would interrupt every pause — so accuracy is measured beside
 * it, against labels chosen before each utterance was spoken.
 */

/** What the speaker was asked to do, decided before they opened their mouth. */
export type TurnLabel = 'complete' | 'incomplete';

/**
 * Who closed the turn. `hangover` is Spike A's 512 ms timer, still in place as the
 * backstop: without it a turn the model never fires on would never end at all.
 */
export type TurnEnding = 'smart-turn' | 'hangover';

/** One run of the model, at one candidate silence. A turn may produce several. */
export interface CandidateMarks {
  /** Last frame that was speech. Same definition as Spike A, before any silence. */
  readonly speechEnd: number | null;
  /** The short silence expired and the 8 s window was cut. */
  readonly candidateAt: number | null;
  /** Log-mel computed. */
  readonly featuresDone: number | null;
  /** Probability back from the model. */
  readonly inferenceDone: number | null;
}

export const EMPTY_CANDIDATE: CandidateMarks = {
  speechEnd: null,
  candidateAt: null,
  featuresDone: null,
  inferenceDone: null,
};

const ORDER = ['speechEnd', 'candidateAt', 'featuresDone', 'inferenceDone'] as const;

export interface CandidateTiming {
  /**
   * The silence waited through before asking. A cost, not a freebie: it is part of what
   * replaces the 512 ms hangover, so it belongs inside the headline rather than beside it.
   */
  readonly silenceMs: number;
  /**
   * Getting the window to the worker and the Whisper log-mel computed. It includes the
   * port hop on purpose — that is latency someone waits through — so it reads slightly
   * higher than the worker's own figure for the extraction alone. If this dominates, the
   * answer is a different feature path rather than a different model.
   */
  readonly featuresMs: number;
  /** onnxruntime-web on one 8 s window, as timed inside the worker. */
  readonly inferenceMs: number;
  /** The headline: end of speech to an answer. Compare against Spike A's 512 ms. */
  readonly detectionMs: number;
}

export type CandidateResult =
  | { readonly complete: true; readonly timing: CandidateTiming }
  | {
      readonly complete: false;
      readonly missing: readonly (keyof CandidateMarks)[];
      readonly outOfOrder: boolean;
    };

export function timeCandidate(marks: CandidateMarks): CandidateResult {
  const missing = ORDER.filter((mark) => marks[mark] === null);
  if (missing.length > 0) return { complete: false, missing, outOfOrder: false };

  const at = (mark: (typeof ORDER)[number]): number => marks[mark] as number;

  for (let i = 1; i < ORDER.length; i += 1) {
    const previous = ORDER[i - 1];
    const current = ORDER[i];
    if (previous === undefined || current === undefined) continue;
    if (at(current) < at(previous)) return { complete: false, missing: [], outOfOrder: true };
  }

  return {
    complete: true,
    timing: {
      silenceMs: at('candidateAt') - at('speechEnd'),
      featuresMs: at('featuresDone') - at('candidateAt'),
      inferenceMs: at('inferenceDone') - at('featuresDone'),
      detectionMs: at('inferenceDone') - at('speechEnd'),
    },
  };
}

/** One labelled utterance, with everything the model said about it along the way. */
export interface LabelledTurn {
  readonly label: TurnLabel;
  readonly ending: TurnEnding;
  /** Every candidate's probability, in order — not just the one that fired. */
  readonly probabilities: readonly number[];
  /** The candidate that ended the turn, or the last one tried if none did. */
  readonly detection: CandidateResult | null;
}

/**
 * Positive means the model said "this turn is finished".
 *
 * The asymmetry matters and is the reason for keeping all four cells rather than one
 * accuracy figure: a false positive interrupts a person mid-sentence, and a false
 * negative costs the 512 ms hangover that is already being paid today. They are not the
 * same mistake and must not average into one number.
 */
export interface ConfusionMatrix {
  /** Complete utterance, model fired. The win. */
  readonly truePositives: number;
  /** Complete utterance, hangover had to close it. A disappointment, not a regression. */
  readonly falseNegatives: number;
  /** Incomplete utterance, model fired. The expensive error. */
  readonly falsePositives: number;
  /** Incomplete utterance, model held off. */
  readonly trueNegatives: number;
  /** Of the incomplete utterances, the share interrupted. `null` if none were spoken. */
  readonly falseFireRate: number | null;
  /** Of the complete utterances, the share that fell through to the timer. */
  readonly missRate: number | null;
}

/** The turn ended because the model said so, rather than because the timer gave up. */
function fired(turn: LabelledTurn): boolean {
  return turn.ending === 'smart-turn';
}

export function confusion(turns: readonly LabelledTurn[]): ConfusionMatrix {
  const count = (label: TurnLabel, didFire: boolean): number =>
    turns.filter((turn) => turn.label === label && fired(turn) === didFire).length;

  const truePositives = count('complete', true);
  const falseNegatives = count('complete', false);
  const falsePositives = count('incomplete', true);
  const trueNegatives = count('incomplete', false);

  const incomplete = falsePositives + trueNegatives;
  const complete = truePositives + falseNegatives;

  return {
    truePositives,
    falseNegatives,
    falsePositives,
    trueNegatives,
    // Never 0/0. A rate over no utterances is "not measured", and reporting it as zero
    // would read as a perfect score for a configuration nobody ran.
    falseFireRate: incomplete === 0 ? null : falsePositives / incomplete,
    missRate: complete === 0 ? null : falseNegatives / complete,
  };
}

/**
 * How much the probabilities move.
 *
 * Spike A's broken q8 path was caught because different audio produced an identical
 * string. The same defect here — wrong features, wrong backend, a graph that never sees
 * its input — produces a *plausible* probability that barely moves. Near-zero spread is
 * a bug to chase, not a result to report, so the number is on screen from the first turn.
 */
export interface ProbabilitySpread {
  readonly count: number;
  readonly min: number | null;
  readonly max: number | null;
  readonly mean: number | null;
  readonly standardDeviation: number | null;
  /** True if any probability fell outside `[0, 1]` — the output is meant to be sigmoid. */
  readonly outOfRange: boolean;
}

export function spread(turns: readonly LabelledTurn[]): ProbabilitySpread {
  const values = turns.flatMap((turn) => [...turn.probabilities]);
  if (values.length === 0) {
    return {
      count: 0,
      min: null,
      max: null,
      mean: null,
      standardDeviation: null,
      outOfRange: false,
    };
  }

  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;

  return {
    count: values.length,
    min: Math.min(...values),
    max: Math.max(...values),
    mean,
    standardDeviation: Math.sqrt(variance),
    outOfRange: values.some((value) => value < 0 || value > 1),
  };
}

export interface DetectionSummary {
  readonly turns: number;
  /** Turns whose marks did not survive. Counted and excluded, never quietly dropped. */
  readonly incomplete: number;
  readonly medianDetectionMs: number | null;
  readonly worstDetectionMs: number | null;
  readonly medianSilenceMs: number | null;
  readonly medianFeaturesMs: number | null;
  readonly medianInferenceMs: number | null;
  /** Model runs per turn. A turn answered on the fourth try costs four inferences. */
  readonly medianCandidatesPerTurn: number | null;
}

/**
 * Summarise the turns the model actually ended.
 *
 * Turns closed by the hangover are excluded from the latency figures on purpose: their
 * detection time is the timer's, not the model's, and averaging the two would let a
 * model that rarely fires report a fast median. They are counted in the confusion matrix,
 * which is where a model that rarely fires is supposed to look bad.
 */
export function summariseDetection(turns: readonly LabelledTurn[]): DetectionSummary {
  const firedTurns = turns.filter(fired);
  const timings = firedTurns
    .map((turn) => turn.detection)
    .filter((result): result is CandidateResult => result !== null)
    .filter((result) => result.complete)
    .map((result) => (result as { complete: true; timing: CandidateTiming }).timing);

  return {
    turns: firedTurns.length,
    incomplete: firedTurns.length - timings.length,
    medianDetectionMs: median(timings.map((timing) => timing.detectionMs)),
    worstDetectionMs:
      timings.length === 0 ? null : Math.max(...timings.map((timing) => timing.detectionMs)),
    medianSilenceMs: median(timings.map((timing) => timing.silenceMs)),
    medianFeaturesMs: median(timings.map((timing) => timing.featuresMs)),
    medianInferenceMs: median(timings.map((timing) => timing.inferenceMs)),
    medianCandidatesPerTurn: median(turns.map((turn) => turn.probabilities.length)),
  };
}
