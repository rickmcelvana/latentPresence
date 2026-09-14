import { useState } from 'react';
import type { ReactElement } from 'react';
import type { TtsVoice } from '@latentpresence/protocol';
import { OpenAICompatibleTTSProvider } from '@latentpresence/providers/web';
import { kokoroVoices, toTtsVoices } from '@latentpresence/ml-web/voices';
import { playSamples } from './audio-sample';
import { ConnectionStatus } from './ConnectionStatus';
import { messageForProbe, openAiCompatibleListing, type ConnectionResult } from './connection';
import type { SettingsDeps } from './deps';
import { KeyField } from './KeyField';
import { TTS_KEY_REF, type TtsSettings } from './settings';

export interface VoiceSectionProps {
  readonly tts: TtsSettings;
  readonly onChange: (next: TtsSettings) => void;
  readonly deps: SettingsDeps;
}

const SAMPLE_TEXT = 'Hello, can you hear me?';
const BROWSER_VOICES = toTtsVoices(kokoroVoices);

function languageLabel(code: string): string {
  return code === 'en-us' ? 'English (US)' : code === 'en-gb' ? 'English (UK)' : code;
}

/** Kokoro's voices grouped by language, for the `<optgroup>` list below. Built from
 * `kokoroVoices` (whose `language` is always a real BCP-47 string) rather than the
 * `TtsVoice[]` `toTtsVoices` returns, whose `language` field is nullable for backends
 * that do not state one. */
const BROWSER_VOICE_GROUPS: readonly { readonly language: string; readonly voices: readonly TtsVoice[] }[] = (() => {
  const order: string[] = [];
  const byLanguage = new Map<string, TtsVoice[]>();
  kokoroVoices.forEach((voice, index) => {
    const ttsVoice = BROWSER_VOICES[index];
    if (ttsVoice === undefined) return;
    const existing = byLanguage.get(voice.language);
    if (existing === undefined) {
      order.push(voice.language);
      byLanguage.set(voice.language, [ttsVoice]);
    } else {
      existing.push(ttsVoice);
    }
  });
  return order.map((language) => ({ language, voices: byLanguage.get(language) ?? [] }));
})();

export function VoiceSection({ tts, onChange, deps }: VoiceSectionProps): ReactElement {
  const [testPending, setTestPending] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionResult | null>(null);
  const [voices, setVoices] = useState<readonly TtsVoice[]>([]);
  const [sampleStatus, setSampleStatus] = useState<ConnectionResult | null>(null);
  const [samplePending, setSamplePending] = useState(false);

  function selectKind(kind: 'kokoro-browser' | 'openai-compatible'): void {
    if (kind === tts.kind) return;
    onChange(
      kind === 'kokoro-browser'
        ? { kind: 'kokoro-browser', voiceId: BROWSER_VOICES[0]?.id ?? 'af_heart', speed: 1 }
        : { kind: 'openai-compatible', baseUrl: '', model: '', voiceId: '', speed: 1 },
    );
    setTestResult(null);
    setVoices([]);
  }

  async function testConnection(): Promise<void> {
    if (tts.kind !== 'openai-compatible') return;
    setTestPending(true);
    setTestResult(null);
    setVoices([]);
    try {
      const apiKey = await deps.vault.loadKey(TTS_KEY_REF);
      const { url, headers } = openAiCompatibleListing(tts.baseUrl, apiKey);
      const probe = await deps.probe(url, { fetch: deps.fetch, headers });
      const message = messageForProbe(probe, { endpointId: 'custom', label: 'the server', url, origin: deps.origin, hasKey: apiKey !== null });
      setTestResult(message);
      if (message.tone === 'ok') {
        const provider = new OpenAICompatibleTTSProvider({
          id: 'tts',
          baseUrl: tts.baseUrl,
          model: tts.model,
          fetch: deps.fetch,
          ...(apiKey === null ? {} : { apiKey }),
        });
        setVoices(await provider.listVoices());
      }
    } catch (error) {
      setTestResult({ tone: 'danger', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setTestPending(false);
    }
  }

  async function playSample(): Promise<void> {
    if (tts.kind !== 'openai-compatible') return;
    setSamplePending(true);
    setSampleStatus({ tone: 'warn', text: 'Synthesising…' });
    try {
      const apiKey = await deps.vault.loadKey(TTS_KEY_REF);
      const provider = new OpenAICompatibleTTSProvider({
        id: 'tts',
        baseUrl: tts.baseUrl,
        model: tts.model,
        fetch: deps.fetch,
        ...(apiKey === null ? {} : { apiKey }),
      });
      const context = deps.createAudioContext();
      for await (const chunk of provider.synthesize({ text: SAMPLE_TEXT, voiceId: tts.voiceId, speed: tts.speed, hint: null })) {
        await playSamples(context, chunk.samples, chunk.sampleRate);
      }
      setSampleStatus({ tone: 'ok', text: 'Playing sample.' });
    } catch (error) {
      setSampleStatus({ tone: 'danger', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setSamplePending(false);
    }
  }

  return (
    <section className="panel settings-section">
      <div className="panel-header">
        <span className="panel-title">Voice</span>
      </div>

      <div className="field">
        <label className="field-label" htmlFor="settings-tts-kind">
          Source
        </label>
        <select
          className="select"
          id="settings-tts-kind"
          onChange={(event) => selectKind(event.target.value as 'kokoro-browser' | 'openai-compatible')}
          value={tts.kind}
        >
          <option value="kokoro-browser">Browser (Kokoro)</option>
          <option value="openai-compatible">OpenAI-compatible server</option>
        </select>
      </div>

      {tts.kind === 'kokoro-browser' && (
        <>
          <p className="field-hint">
            Runs on this computer&apos;s GPU. It downloads the first time a call starts, once you agree — nothing is
            fetched from this page.
          </p>
          <div className="field">
            <label className="field-label" htmlFor="settings-tts-voice">
              Voice
            </label>
            <select
              className="select"
              id="settings-tts-voice"
              onChange={(event) => onChange({ ...tts, voiceId: event.target.value })}
              value={tts.voiceId}
            >
              {BROWSER_VOICE_GROUPS.map(({ language, voices: groupVoices }) => (
                <optgroup key={language} label={languageLabel(language)}>
                  {groupVoices.map((voice) => (
                    <option key={voice.id} value={voice.id}>
                      {voice.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
        </>
      )}

      {tts.kind === 'openai-compatible' && (
        <>
          <div className="field">
            <label className="field-label" htmlFor="settings-tts-base-url">
              Base URL
            </label>
            <input
              className="input"
              id="settings-tts-base-url"
              onChange={(event) => onChange({ ...tts, baseUrl: event.target.value })}
              value={tts.baseUrl}
            />
          </div>
          <KeyField hint={null} id="settings-tts-key" label="API key" optional refKey={TTS_KEY_REF} vault={deps.vault} />
          <div className="field">
            <label className="field-label" htmlFor="settings-tts-model">
              Model
            </label>
            <input
              className="input"
              id="settings-tts-model"
              onChange={(event) => onChange({ ...tts, model: event.target.value })}
              value={tts.model}
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="settings-tts-voice">
              Voice
            </label>
            {voices.length > 0 ? (
              <select
                className="select"
                id="settings-tts-voice"
                onChange={(event) => onChange({ ...tts, voiceId: event.target.value })}
                value={tts.voiceId}
              >
                <option value="">Choose a voice…</option>
                {voices.map((voice) => (
                  <option key={voice.id} value={voice.id}>
                    {voice.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="input"
                id="settings-tts-voice"
                onChange={(event) => onChange({ ...tts, voiceId: event.target.value })}
                placeholder="Voice id"
                value={tts.voiceId}
              />
            )}
          </div>
          <div className="settings-test-row">
            <button className="btn btn-sm" disabled={testPending} onClick={() => void testConnection()} type="button">
              Test connection
            </button>
            <ConnectionStatus pending={testPending} result={testResult} />
          </div>
        </>
      )}

      <div className="field">
        <span className="field-label">Speed</span>
        <div className="settings-speed-row">
          <input
            aria-label="Speed"
            max={1.25}
            min={0.75}
            onChange={(event) => onChange({ ...tts, speed: Number(event.target.value) })}
            step={0.05}
            type="range"
            value={tts.speed}
          />
          <span className="field-hint">{tts.speed.toFixed(2)}×</span>
        </div>
      </div>

      {/* A server only: browser Kokoro has nothing to play until its model is downloaded,
          and that waits for consent (P1-T13). */}
      {tts.kind === 'openai-compatible' && (
        <div className="settings-test-row">
          <button className="btn btn-sm" disabled={samplePending || tts.voiceId === ''} onClick={() => void playSample()} type="button">
            Play sample
          </button>
          <ConnectionStatus pending={false} result={sampleStatus} />
        </div>
      )}
    </section>
  );
}
