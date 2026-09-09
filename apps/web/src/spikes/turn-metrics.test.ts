import { describe, expect, it } from 'vitest';
import {
  EMPTY_CANDIDATE,
  type LabelledTurn,
  confusion,
  spread,
  summariseDetection,
  timeCandidate,
} from './turn-metrics';

/**
 * What would otherwise turn a measurement error into an architectural decision.
 *
 * The confusion tests carry most of the weight: the spike's whole question is whether
 * firing early is worth the risk of interrupting, and a matrix that puts a false fire in
 * the wrong cell would answer it backwards while looking healthy.
 */

const MARKS = {
  speechEnd: 1000,
  candidateAt: 1200,
  featuresDone: 1260,
  inferenceDone: 1275,
};

function turn(partial: Partial<LabelledTurn> = {}): LabelledTurn {
  return {
    label: 'complete',
    ending: 'smart-turn',
    probabilities: [0.9],
    detection: timeCandidate(MARKS),
    ...partial,
  };
}

describe('timeCandidate', () => {
  it('splits the wait into silence, features and inference', () => {
    const result = timeCandidate(MARKS);

    expect(result.complete).toBe(true);
    if (!result.complete) return;
    expect(result.timing.silenceMs).toBe(200);
    expect(result.timing.featuresMs).toBe(60);
    expect(result.timing.inferenceMs).toBe(15);
    // The headline covers the candidate silence too. Reporting only features plus
    // inference would flatter the model by hiding the wait that made it possible.
    expect(result.timing.detectionMs).toBe(275);
  });

  it('reports a missing mark rather than a fast candidate', () => {
    // Without `featuresDone` the arithmetic still "works" and produces a short,
    // believable latency. Spike A shipped fifteen incomplete turns rather than fifteen
    // wrong numbers, and this keeps that.
    const result = timeCandidate({ ...MARKS, featuresDone: null });

    expect(result.complete).toBe(false);
    if (result.complete) return;
    expect(result.missing).toEqual(['featuresDone']);
    expect(result.outOfOrder).toBe(false);
  });

  it('reports marks that arrived out of order', () => {
    const result = timeCandidate({ ...MARKS, inferenceDone: 900 });

    expect(result.complete).toBe(false);
    if (result.complete) return;
    expect(result.outOfOrder).toBe(true);
  });

  it('treats an untouched candidate as incomplete on every mark', () => {
    const result = timeCandidate(EMPTY_CANDIDATE);

    expect(result.complete).toBe(false);
    if (result.complete) return;
    expect(result.missing).toHaveLength(4);
  });
});

describe('confusion', () => {
  it('puts a fire on an incomplete utterance in the expensive cell', () => {
    // Someone pauses mid-sentence and the model says "finished": the assistant talks
    // over them. This is the error the write-up leads with, so it must not land
    // anywhere else.
    const matrix = confusion([
      turn({ label: 'incomplete', ending: 'smart-turn' }),
      turn({ label: 'incomplete', ending: 'hangover' }),
      turn({ label: 'incomplete', ending: 'hangover' }),
      turn({ label: 'incomplete', ending: 'hangover' }),
    ]);

    expect(matrix.falsePositives).toBe(1);
    expect(matrix.trueNegatives).toBe(3);
    expect(matrix.falseFireRate).toBeCloseTo(0.25, 6);
  });

  it('counts a hangover close on a finished sentence as a miss, not a fire', () => {
    const matrix = confusion([
      turn({ label: 'complete', ending: 'smart-turn' }),
      turn({ label: 'complete', ending: 'smart-turn' }),
      turn({ label: 'complete', ending: 'smart-turn' }),
      turn({ label: 'complete', ending: 'hangover' }),
    ]);

    expect(matrix.truePositives).toBe(3);
    expect(matrix.falseNegatives).toBe(1);
    expect(matrix.missRate).toBeCloseTo(0.25, 6);
  });

  it('takes each rate over its own label, not over everything', () => {
    // The denominators are the trap. Dividing false fires by all turns lets a run
    // padded with easy complete utterances report a low interruption rate.
    const matrix = confusion([
      turn({ label: 'incomplete', ending: 'smart-turn' }),
      turn({ label: 'incomplete', ending: 'hangover' }),
      ...Array.from({ length: 8 }, () => turn({ label: 'complete', ending: 'smart-turn' })),
    ]);

    expect(matrix.falseFireRate).toBeCloseTo(0.5, 6);
    expect(matrix.missRate).toBe(0);
  });

  it('credits a late answer as a fire, because the model was right and slow', () => {
    // The 2026-09-08 run: p=0.979 on a finished sentence, arriving after the 512 ms
    // backstop had closed the turn. Counting that as a miss blames the model for a
    // problem that belongs to the backend.
    const matrix = confusion([
      turn({ label: 'complete', ending: 'late' }),
      turn({ label: 'complete', ending: 'smart-turn' }),
    ]);

    expect(matrix.truePositives).toBe(2);
    expect(matrix.falseNegatives).toBe(0);
    expect(matrix.missRate).toBe(0);
  });

  it('says "not measured" rather than zero when a label was never spoken', () => {
    const matrix = confusion([turn({ label: 'complete', ending: 'smart-turn' })]);

    expect(matrix.falseFireRate).toBeNull();
    expect(matrix.missRate).toBe(0);
  });
});

describe('spread', () => {
  it('shows a model whose output barely moves', () => {
    // The Spike A failure in this spike's clothes: every window scores the same, so the
    // features never reached the graph. Plausible probabilities, no information.
    const stuck = spread([
      turn({ probabilities: [0.5001] }),
      turn({ probabilities: [0.5002] }),
      turn({ probabilities: [0.4999] }),
    ]);

    expect(stuck.count).toBe(3);
    expect(stuck.standardDeviation).toBeLessThan(0.001);
    expect(stuck.outOfRange).toBe(false);
  });

  it('counts every candidate, not one per turn', () => {
    const wide = spread([turn({ probabilities: [0.1, 0.4, 0.95] }), turn({ probabilities: [0.2] })]);

    expect(wide.count).toBe(4);
    expect(wide.min).toBeCloseTo(0.1, 6);
    expect(wide.max).toBeCloseTo(0.95, 6);
  });

  it('flags a probability outside the sigmoid range', () => {
    // The graph's output is named `logits` and is believed to be already activated.
    // If that is ever wrong, this is how it announces itself.
    const raw = spread([turn({ probabilities: [-2.3, 4.1] })]);

    expect(raw.outOfRange).toBe(true);
  });

  it('reports nothing rather than NaN before any turn', () => {
    expect(spread([])).toMatchObject({ count: 0, mean: null, standardDeviation: null });
  });
});

describe('summariseDetection', () => {
  it('measures only the turns the model ended', () => {
    // A turn the hangover closed took 512 ms by definition. Letting it into the median
    // would let a model that almost never fires report a fast one.
    const summary = summariseDetection([
      turn({ ending: 'smart-turn' }),
      turn({ ending: 'hangover', detection: null }),
      turn({ ending: 'hangover', detection: null }),
    ]);

    expect(summary.turns).toBe(1);
    expect(summary.medianDetectionMs).toBe(275);
  });

  it('counts a fired turn with broken marks as incomplete', () => {
    const summary = summariseDetection([
      turn({ ending: 'smart-turn' }),
      turn({ ending: 'smart-turn', detection: timeCandidate({ ...MARKS, candidateAt: null }) }),
    ]);

    expect(summary.turns).toBe(2);
    expect(summary.incomplete).toBe(1);
    expect(summary.medianDetectionMs).toBe(275);
  });

  it('averages the middle pair on an even count', () => {
    const slower = timeCandidate({ ...MARKS, inferenceDone: 1325 });
    const summary = summariseDetection([turn(), turn({ detection: slower })]);

    expect(summary.medianDetectionMs).toBe(300);
    expect(summary.worstDetectionMs).toBe(325);
  });

  it('reports how many model runs a turn took', () => {
    const summary = summariseDetection([
      turn({ probabilities: [0.1, 0.2, 0.9] }),
      turn({ probabilities: [0.9] }),
      turn({ probabilities: [0.3, 0.9] }),
    ]);

    expect(summary.medianCandidatesPerTurn).toBe(2);
  });

  it('keeps a late answer out of the latency medians and counts it separately', () => {
    // Its detection time is the timer's, not the model's. A backend that keeps losing
    // that race would otherwise report the median of the few turns it won.
    const slower = timeCandidate({ ...MARKS, inferenceDone: 1900 });
    const summary = summariseDetection([
      turn({ ending: 'smart-turn' }),
      turn({ ending: 'late', detection: slower }),
      turn({ ending: 'late', detection: slower }),
    ]);

    expect(summary.turns).toBe(1);
    expect(summary.medianDetectionMs).toBe(275);
    expect(summary.lateAnswers).toBe(2);
  });

  it('has nothing to say about a run with no turns', () => {
    expect(summariseDetection([])).toMatchObject({
      turns: 0,
      medianDetectionMs: null,
      worstDetectionMs: null,
      lateAnswers: 0,
    });
  });
});
