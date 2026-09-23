import { describe, expect, it } from 'vitest';
import { asrModel, kokoroModel, sileroVadModel, smartTurnModel } from '@latentpresence/ml-web';
import type { Settings } from '../settings/settings';
import { browserModelsFor, voiceModelsFor } from './models';

/**
 * The consent list has to be exactly what the call builds. Too long and the screen asks
 * about something nothing downloads; too short and `requireConsent` throws *after* the
 * user agreed, which reads as a broken Start voice button.
 */

function settings(overrides: Partial<Pick<Settings, 'tts' | 'stt'>> = {}): Pick<Settings, 'tts' | 'stt'> {
  return {
    tts: { kind: 'kokoro-browser', voiceId: 'af_heart', speed: 1 },
    stt: { kind: 'moonshine-browser', model: 'moonshine-tiny' },
    ...overrides,
  };
}

function ids(models: readonly { id: string }[]): string[] {
  return models.map((model) => model.id);
}

describe('browserModelsFor', () => {
  it('asks for the turn models and both browser defaults', () => {
    expect(ids(browserModelsFor(settings()))).toEqual([
      sileroVadModel().id,
      smartTurnModel('gpu').id,
      asrModel('moonshine-tiny', 'fp32').id,
      kokoroModel('fp32').id,
    ]);
  });

  it('keeps the two turn models when both voice and hearing are servers', () => {
    // Neither turn model has a server counterpart in this project — `TurnDetector` takes
    // Silero's probabilities and Smart Turn's answer — so a call over two servers still
    // downloads exactly these two, and nothing else.
    const models = browserModelsFor(
      settings({
        tts: { kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:8880/v1', model: 'kokoro', voiceId: 'af_heart', speed: 1 },
        stt: { kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:8880/v1', model: 'whisper-1', language: null },
      }),
    );
    expect(ids(models)).toEqual([sileroVadModel().id, smartTurnModel('gpu').id]);
  });

  it('follows the model chosen in the Hearing section, not the default', () => {
    const models = browserModelsFor(settings({ stt: { kind: 'whisper-browser', model: 'whisper-base' } }));
    expect(ids(models)).toContain(asrModel('whisper-base', 'fp32').id);
    expect(ids(models)).not.toContain(asrModel('moonshine-tiny', 'fp32').id);
  });

  it('drops only the part that stopped being a browser model', () => {
    const serverVoice = browserModelsFor(
      settings({ tts: { kind: 'openai-compatible', baseUrl: '', model: '', voiceId: '', speed: 1 } }),
    );
    expect(ids(serverVoice)).toContain(asrModel('moonshine-tiny', 'fp32').id);
    expect(ids(serverVoice)).not.toContain(kokoroModel('fp32').id);
  });

  it('never names a model twice, because consent is per id', () => {
    const models = browserModelsFor(settings());
    expect(new Set(ids(models)).size).toBe(models.length);
  });
});

describe('voiceModelsFor (P2-T08)', () => {
  it('asks for the voice alone: no microphone, so no turn models and no recogniser', () => {
    expect(ids(voiceModelsFor(settings()))).toEqual([kokoroModel('fp32').id]);
  });

  it('asks for nothing when the voice is a server', () => {
    expect(voiceModelsFor(settings({ tts: { kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:8880/v1', model: 'kokoro', voiceId: 'af_heart', speed: 1 } }))).toEqual([]);
  });
});
