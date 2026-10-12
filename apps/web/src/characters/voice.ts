import type { Persona } from '@latentpresence/protocol';
import type { Settings } from '../settings/settings';

/**
 * The voice a character speaks with (P6-T06, ADR-55), from the settings and the persona:
 *
 * 1. the choice saved for this character, **if it was made for the engine now in use** — a
 *    Kokoro voice id means nothing to a server, nor the other way round;
 * 2. else, on Kokoro, the persona's own voice (its file states a preference), at the speed the
 *    person set in Settings → Voice;
 * 3. else the voice and speed chosen in Settings → Voice, the one voice a server has to offer.
 */
export function characterVoice(settings: Settings, persona: Persona): { voiceId: string; speed: number } {
  const saved = settings.characters[persona.id]?.voice ?? null;
  if (saved !== null && saved.kind === settings.tts.kind) return { voiceId: saved.voiceId, speed: saved.speed };
  if (settings.tts.kind === 'kokoro-browser') return { voiceId: persona.voice.voiceId, speed: settings.tts.speed };
  return { voiceId: settings.tts.voiceId, speed: settings.tts.speed };
}

/** `settings` with its voice and speed replaced by the character's, for whatever speaks. */
export function withCharacterVoice(settings: Settings, persona: Persona): Settings {
  const { voiceId, speed } = characterVoice(settings, persona);
  return { ...settings, tts: { ...settings.tts, voiceId, speed } };
}
