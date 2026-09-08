import { describe, expect, it } from 'vitest';
import { SPIKE_MODELS, formatMb, totalBytes } from './consent';
import { EMPTY_MARKS, type TurnMarks, median, summarise, timeTurn } from './metrics';

/** A turn where every stage took a round number, so the arithmetic is easy to read. */
const goodTurn: TurnMarks = {
  speechStart: 1000,
  speechEnd: 2500,
  vadSettled: 2900,
  sttFirstResult: 3050,
  sttDone: 3100,
  ttsFirstAudio: 3400,
};

describe('timeTurn', () => {
  it('breaks a turn into stages that add up to the headline', () => {
    // The headline is the number the go/no-go rests on. If the breakdown does not sum
    // to it, some stage is being measured from the wrong mark and the write-up would
    // point at the wrong bottleneck.
    const result = timeTurn(goodTurn);
    expect(result.complete).toBe(true);
    if (!result.complete) return;

    const { speechMs, hangoverMs, sttMs, ttsMs, endToFirstAudioMs } = result.timing;
    expect(speechMs).toBe(1500);
    expect(hangoverMs).toBe(400);
    expect(sttMs).toBe(200);
    expect(ttsMs).toBe(300);
    expect(endToFirstAudioMs).toBe(900);
    expect(hangoverMs + sttMs + ttsMs).toBe(endToFirstAudioMs);
  });

  it('measures end of speech, not end of the hangover', () => {
    // Waiting longer for silence must not make the pipeline look slower: the hangover
    // is a tuning choice, and P0-T07 exists to shrink it. Doubling it moves the
    // headline by exactly that much and leaves recognition and synthesis untouched.
    const patient = timeTurn({ ...goodTurn, vadSettled: 3300, sttDone: 3500, ttsFirstAudio: 3800 });
    expect(patient.complete).toBe(true);
    if (!patient.complete) return;

    expect(patient.timing.hangoverMs).toBe(800);
    expect(patient.timing.sttMs).toBe(200);
    expect(patient.timing.ttsMs).toBe(300);
    expect(patient.timing.endToFirstAudioMs).toBe(1300);
  });

  it('refuses a turn with a dropped mark instead of inventing a fast one', () => {
    // Without sttDone, synthesis would be measured from the utterance closing and the
    // turn would read as 200 ms quicker than it was. A missing mark is not a number.
    const result = timeTurn({ ...goodTurn, sttDone: null });
    expect(result.complete).toBe(false);
    if (result.complete) return;
    expect(result.missing).toEqual(['sttDone']);
  });

  it('lists every missing mark, not just the first', () => {
    const result = timeTurn(EMPTY_MARKS);
    expect(result.complete).toBe(false);
    if (result.complete) return;
    expect(result.missing).toEqual([
      'speechStart',
      'speechEnd',
      'vadSettled',
      'sttDone',
      'ttsFirstAudio',
    ]);
  });

  it('rejects marks that arrive out of order', () => {
    // A worker posting a message late can land ttsFirstAudio before sttDone. That is a
    // negative interval, which would quietly drag a median down.
    const result = timeTurn({ ...goodTurn, ttsFirstAudio: 3000 });
    expect(result.complete).toBe(false);
    if (result.complete) return;
    expect(result.outOfOrder).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('does not require the streaming mark, which Moonshine does not produce', () => {
    const result = timeTurn({ ...goodTurn, sttFirstResult: null });
    expect(result.complete).toBe(true);
  });
});

describe('median', () => {
  it('averages the middle pair on an even count', () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([7])).toBe(7);
  });

  it('returns null for no readings rather than zero', () => {
    // Zero would print as a spectacular result in the write-up.
    expect(median([])).toBeNull();
  });
});

describe('summarise', () => {
  it('counts failed turns instead of hiding them', () => {
    // Ten attempts of which four failed is a different result from six good ones, and
    // the write-up has to be able to say which happened.
    const results = [
      timeTurn(goodTurn),
      timeTurn({ ...goodTurn, ttsFirstAudio: 3600 }),
      timeTurn({ ...goodTurn, sttDone: null }),
    ];
    const summary = summarise(results);

    expect(summary.runs).toBe(3);
    expect(summary.incomplete).toBe(1);
    expect(summary.medianEndToFirstAudioMs).toBe(1000);
    expect(summary.worstEndToFirstAudioMs).toBe(1100);
  });

  it('reports nothing rather than zero when every turn failed', () => {
    const summary = summarise([timeTurn(EMPTY_MARKS)]);
    expect(summary.runs).toBe(1);
    expect(summary.incomplete).toBe(1);
    expect(summary.medianEndToFirstAudioMs).toBeNull();
    expect(summary.worstEndToFirstAudioMs).toBeNull();
  });
});

describe('the consent manifest', () => {
  it('can answer size, licence and source for every model', () => {
    // ADR-09: the screen cannot do its job with a field missing, and a model added
    // later without a licence would slip through as an empty table cell.
    expect(SPIKE_MODELS.length).toBeGreaterThan(0);
    for (const model of SPIKE_MODELS) {
      expect(model.label, model.repo).not.toBe('');
      expect(model.licence, model.repo).not.toBe('');
      expect(model.bytes, model.repo).toBeGreaterThan(0);
      expect(model.sourceUrl, model.repo).toMatch(/^https:\/\/huggingface\.co\//);
      expect(model.sourceUrl, model.repo).toContain(model.repo);
    }
  });

  it('covers all three stages of the pipeline', () => {
    // A stage with no entry is a stage that downloads without consent.
    expect(new Set(SPIKE_MODELS.map((model) => model.stage))).toEqual(
      new Set(['vad', 'stt', 'tts']),
    );
  });

  it('totals the download the user is agreeing to', () => {
    expect(totalBytes()).toBe(116_450_000);
    expect(formatMb(totalBytes())).toBe('116.5 MB');
  });
});
