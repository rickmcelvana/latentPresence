import { describe, expect, it } from 'vitest';
import type { SpokenAudioChunk, TTSProvider, TtsRequest } from '@latentpresence/protocol';
import { Cancellation } from '../cancellation';
import { BACKCHANNEL_PADDING, DEFAULT_BACKCHANNEL_PHRASES, prepareBackchannels } from './clips';

const RATE = 24_000;
const ms = (value: number): number => Math.round((value / 1000) * RATE);

/** Kokoro's shape: ~400 ms of silence, the word, ~500 ms of silence, then an empty final chunk. */
class PaddedTTS implements TTSProvider {
  readonly id = 'padded';
  readonly requests: TtsRequest[] = [];
  private readonly options: { silent?: string; fail?: string; onRequest?: () => void };
  constructor(options: { silent?: string; fail?: string; onRequest?: () => void } = {}) {
    this.options = options;
  }
  async capabilities(): Promise<never> {
    throw new Error('unused');
  }
  async listVoices(): Promise<never[]> {
    return [];
  }
  async *synthesize(request: TtsRequest): AsyncIterable<SpokenAudioChunk> {
    this.requests.push(request);
    this.options.onRequest?.();
    if (request.text === this.options.fail) throw new Error('voice failed');
    const samples = new Float32Array(ms(400) + ms(300) + ms(500));
    if (request.text !== this.options.silent) samples.fill(0.4, ms(400), ms(700));
    yield { samples: samples.subarray(0, ms(600)), sampleRate: RATE, startMs: 0, isFinal: false };
    yield { samples: samples.subarray(ms(600)), sampleRate: RATE, startMs: 600, isFinal: false };
    yield { samples: new Float32Array(0), sampleRate: RATE, startMs: 1200, isFinal: true };
  }
}

describe('prepareBackchannels', () => {
  it('synthesises the default words in the given voice, in order, one at a time', async () => {
    const tts = new PaddedTTS();
    const clips = await prepareBackchannels(tts, { voiceId: 'af_heart', speed: 1.1 });
    expect(clips.map((clip) => clip.text)).toEqual(DEFAULT_BACKCHANNEL_PHRASES);
    expect(tts.requests).toEqual(
      DEFAULT_BACKCHANNEL_PHRASES.map((text) => ({ text, voiceId: 'af_heart', speed: 1.1, hint: null })),
    );
  });

  it('joins the chunks and trims each clip to its voice plus 50 ms either side', async () => {
    const [clip] = await prepareBackchannels(new PaddedTTS(), { voiceId: 'v', phrases: ['Yeah.'] });
    expect(BACKCHANNEL_PADDING).toEqual({ leadMs: 50, tailMs: 50 });
    expect(clip?.sampleRate).toBe(RATE);
    expect(clip?.samples.length).toBe(ms(50) + ms(300) + ms(50));
    expect(clip?.samples[ms(50) - 1]).toBe(0);
    expect(clip?.samples[ms(50)]).toBeCloseTo(0.4);
  });

  it('leaves out a phrase that came back silent', async () => {
    const clips = await prepareBackchannels(new PaddedTTS({ silent: 'Mhm.' }), { voiceId: 'v', phrases: ['Mhm.', 'Right.'] });
    expect(clips.map((clip) => clip.text)).toEqual(['Right.']);
  });

  it('fails the set when the voice fails', async () => {
    await expect(
      prepareBackchannels(new PaddedTTS({ fail: 'Right.' }), { voiceId: 'v', phrases: ['Yeah.', 'Right.'] }),
    ).rejects.toThrow('voice failed');
  });

  it('stops asking for phrases once cancelled', async () => {
    const cancellation = new Cancellation();
    const tts = new PaddedTTS({ onRequest: () => cancellation.abort() });
    const clips = await prepareBackchannels(tts, { voiceId: 'v', phrases: ['Yeah.', 'Right.'], signal: cancellation });
    expect(tts.requests).toHaveLength(1);
    expect(clips).toHaveLength(1);
  });
});
