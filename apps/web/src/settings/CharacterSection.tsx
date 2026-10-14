import type { ReactElement } from 'react';
import { PACKS, packFor } from '../characters/packs';
import type { CharacterSettings, TtsSettings } from './settings';
import { BROWSER_VOICE_GROUPS, languageLabel } from './VoiceSection';

export interface CharacterSectionProps {
  /** The active character's id. */
  readonly character: string;
  readonly characters: Readonly<Record<string, CharacterSettings>>;
  /** The engine in use: a saved voice counts only for the engine it was chosen on. */
  readonly tts: TtsSettings;
  readonly onSelect: (id: string) => void;
  readonly onVoice: (id: string, voice: CharacterSettings['voice']) => void;
}

/**
 * Who she is, and what she sounds like (P6-T06, ADR-55). The same choice as "Talking to" in
 * `/chat`, and the voice for the active character: on Kokoro a voice from the list, on a server
 * a voice id. No choice (`null`) is the persona's own voice on Kokoro, the one in Voice elsewhere.
 * Everything else in Settings stays the person's, not the character's.
 */
export function CharacterSection({ character, characters, tts, onSelect, onVoice }: CharacterSectionProps): ReactElement {
  const pack = packFor(character);
  const { persona } = pack;
  const saved = characters[persona.id]?.voice ?? null;
  const savedHere = saved !== null && saved.kind === tts.kind ? saved : null;

  return (
    <section className="panel settings-section">
      <div className="panel-header">
        <span className="panel-title">Character</span>
      </div>

      <div className="field">
        <label className="field-label" htmlFor="settings-character">
          Talking to
        </label>
        <select className="select" id="settings-character" onChange={(event) => onSelect(event.target.value)} value={persona.id}>
          {PACKS.map((candidate) => (
            <option key={candidate.persona.id} value={candidate.persona.id}>
              {candidate.persona.name}
            </option>
          ))}
        </select>
      </div>
      <p className="field-hint">{persona.summary}</p>
      <p className="field-hint">
        {persona.name}&apos;s body is chosen in the call, under Body: it changes while you talk.
      </p>

      <div className="field">
        <label className="field-label" htmlFor="settings-character-voice">
          Voice for {persona.name}
        </label>
        {tts.kind === 'kokoro-browser' ? (
          <select
            className="select"
            id="settings-character-voice"
            onChange={(event) => onVoice(persona.id, event.target.value === '' ? null : { kind: 'kokoro-browser', voiceId: event.target.value, speed: tts.speed })}
            value={savedHere?.voiceId ?? ''}
          >
            <option value="">
              {persona.name}&apos;s own ({persona.voice.voiceId})
            </option>
            {BROWSER_VOICE_GROUPS.map(({ language, voices }) => (
              <optgroup key={language} label={languageLabel(language)}>
                {voices.map((voice) => (
                  <option key={voice.id} value={voice.id}>
                    {voice.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        ) : (
          <input
            className="input"
            id="settings-character-voice"
            onChange={(event) => {
              const voiceId = event.target.value.trim();
              onVoice(persona.id, voiceId === '' ? null : { kind: 'openai-compatible', voiceId, speed: tts.speed });
            }}
            placeholder="Blank: the voice in Voice"
            value={savedHere?.voiceId ?? ''}
          />
        )}
      </div>
      <p className="field-hint">
        {tts.kind === 'kokoro-browser'
          ? `Used while the voice is the browser's (Kokoro). Each character keeps their own.`
          : `Used while the voice is the OpenAI-compatible server. Blank means the voice chosen in Voice.`}
      </p>
    </section>
  );
}
