import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '../settings/settings';
import { packFor } from './packs';
import { characterVoice, withCharacterVoice } from './voice';

const theo = packFor('theo').persona;
const alice = packFor('alice').persona;

const onServer: Settings = {
  ...DEFAULT_SETTINGS,
  tts: { kind: 'openai-compatible', baseUrl: 'http://x/v1', model: 'tts-1', voiceId: 'alloy', speed: 1.1 },
};

describe('characterVoice (P6-T06, ADR-55)', () => {
  it('uses the choice saved for the character when it was made for the engine in use', () => {
    const settings: Settings = { ...DEFAULT_SETTINGS, characters: { theo: { voice: { kind: 'kokoro-browser', voiceId: 'bm_george', speed: 0.9 }, body: null } } };
    expect(characterVoice(settings, theo)).toEqual({ voiceId: 'bm_george', speed: 0.9 });
  });

  it('uses the persona voice on Kokoro with no choice saved, at the speed from Settings → Voice', () => {
    const settings: Settings = { ...DEFAULT_SETTINGS, tts: { kind: 'kokoro-browser', voiceId: 'bf_emma', speed: 1.2 } };
    expect(characterVoice(settings, theo)).toEqual({ voiceId: 'am_michael', speed: 1.2 });
    expect(characterVoice(settings, alice)).toEqual({ voiceId: 'af_heart', speed: 1.2 });
  });

  it('uses the persona voice on Kokoro when the saved choice is null', () => {
    const settings: Settings = { ...DEFAULT_SETTINGS, characters: { theo: { voice: null, body: null } } };
    expect(characterVoice(settings, theo).voiceId).toBe('am_michael');
  });

  it('ignores a choice made for another engine: a Kokoro voice means nothing to a server', () => {
    const settings: Settings = { ...onServer, characters: { theo: { voice: { kind: 'kokoro-browser', voiceId: 'bm_george', speed: 0.9 }, body: null } } };
    expect(characterVoice(settings, theo)).toEqual({ voiceId: 'alloy', speed: 1.1 });
  });

  it('uses the voice from Settings → Voice on a server with no choice saved', () => {
    expect(characterVoice(onServer, theo)).toEqual({ voiceId: 'alloy', speed: 1.1 });
  });

  it('uses a choice saved for the server engine, for that character only', () => {
    const settings: Settings = { ...onServer, characters: { theo: { voice: { kind: 'openai-compatible', voiceId: 'onyx', speed: 1 }, body: null } } };
    expect(characterVoice(settings, theo)).toEqual({ voiceId: 'onyx', speed: 1 });
    expect(characterVoice(settings, alice)).toEqual({ voiceId: 'alloy', speed: 1.1 });
  });

  it('withCharacterVoice copies the settings with only the voice and speed replaced', () => {
    const settings: Settings = { ...onServer, characters: { theo: { voice: { kind: 'openai-compatible', voiceId: 'onyx', speed: 1 }, body: null } } };
    const copy = withCharacterVoice(settings, theo);
    expect(copy.tts).toEqual({ kind: 'openai-compatible', baseUrl: 'http://x/v1', model: 'tts-1', voiceId: 'onyx', speed: 1 });
    expect(copy).not.toBe(settings);
    expect(settings.tts.voiceId).toBe('alloy');
    expect(withCharacterVoice(DEFAULT_SETTINGS, theo).tts).toEqual({ kind: 'kokoro-browser', voiceId: 'am_michael', speed: 1 });
  });
});
