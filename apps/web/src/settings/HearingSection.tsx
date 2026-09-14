import { useState } from 'react';
import type { ReactElement } from 'react';
import { ConnectionStatus } from './ConnectionStatus';
import { messageForProbe, openAiCompatibleListing, type ConnectionResult } from './connection';
import type { SettingsDeps } from './deps';
import { KeyField } from './KeyField';
import { STT_KEY_REF, type SttSettings } from './settings';

export interface HearingSectionProps {
  readonly stt: SttSettings;
  readonly onChange: (next: SttSettings) => void;
  readonly deps: SettingsDeps;
}

type SttKind = SttSettings['kind'];

export function HearingSection({ stt, onChange, deps }: HearingSectionProps): ReactElement {
  const [testPending, setTestPending] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionResult | null>(null);

  function selectKind(kind: SttKind): void {
    if (kind === stt.kind) return;
    setTestResult(null);
    if (kind === 'moonshine-browser') onChange({ kind, model: 'moonshine-tiny' });
    else if (kind === 'whisper-browser') onChange({ kind, model: 'whisper-tiny-en' });
    else onChange({ kind: 'openai-compatible', baseUrl: '', model: '', language: null });
  }

  async function testConnection(): Promise<void> {
    if (stt.kind !== 'openai-compatible') return;
    setTestPending(true);
    setTestResult(null);
    try {
      const apiKey = await deps.vault.loadKey(STT_KEY_REF);
      const { url, headers } = openAiCompatibleListing(stt.baseUrl, apiKey);
      const probe = await deps.probe(url, { fetch: deps.fetch, headers });
      setTestResult(messageForProbe(probe, { endpointId: 'custom', label: 'the server', url, origin: deps.origin, hasKey: apiKey !== null }));
    } catch (error) {
      setTestResult({ tone: 'danger', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setTestPending(false);
    }
  }

  return (
    <section className="panel settings-section">
      <div className="panel-header">
        <span className="panel-title">Hearing</span>
      </div>

      <div className="field">
        <label className="field-label" htmlFor="settings-stt-kind">
          Source
        </label>
        <select className="select" id="settings-stt-kind" onChange={(event) => selectKind(event.target.value as SttKind)} value={stt.kind}>
          <option value="moonshine-browser">Moonshine (browser)</option>
          <option value="whisper-browser">Whisper (browser)</option>
          <option value="openai-compatible">OpenAI-compatible server</option>
        </select>
      </div>

      {stt.kind === 'moonshine-browser' && (
        <>
          <p className="field-hint">Runs on this computer. It downloads the first time a call starts, once you agree.</p>
          <div className="field">
            <label className="field-label" htmlFor="settings-stt-model">
              Model
            </label>
            <select
              className="select"
              id="settings-stt-model"
              onChange={(event) => onChange({ kind: 'moonshine-browser', model: event.target.value as 'moonshine-tiny' | 'moonshine-base' })}
              value={stt.model}
            >
              <option value="moonshine-tiny">Tiny</option>
              <option value="moonshine-base">Base</option>
            </select>
          </div>
        </>
      )}

      {stt.kind === 'whisper-browser' && (
        <>
          <p className="field-hint">Runs on this computer. It downloads the first time a call starts, once you agree.</p>
          <div className="field">
            <label className="field-label" htmlFor="settings-stt-model">
              Model
            </label>
            <select
              className="select"
              id="settings-stt-model"
              onChange={(event) => onChange({ kind: 'whisper-browser', model: event.target.value as 'whisper-base' | 'whisper-tiny-en' })}
              value={stt.model}
            >
              <option value="whisper-tiny-en">Tiny (English)</option>
              <option value="whisper-base">Base</option>
            </select>
          </div>
        </>
      )}

      {stt.kind === 'openai-compatible' && (
        <>
          <div className="field">
            <label className="field-label" htmlFor="settings-stt-base-url">
              Base URL
            </label>
            <input
              className="input"
              id="settings-stt-base-url"
              onChange={(event) => onChange({ ...stt, baseUrl: event.target.value })}
              value={stt.baseUrl}
            />
          </div>
          <KeyField hint={null} id="settings-stt-key" label="API key" optional refKey={STT_KEY_REF} vault={deps.vault} />
          <div className="field">
            <label className="field-label" htmlFor="settings-stt-model">
              Model
            </label>
            <input
              className="input"
              id="settings-stt-model"
              onChange={(event) => onChange({ ...stt, model: event.target.value })}
              value={stt.model}
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="settings-stt-language">
              Language
            </label>
            <input
              className="input"
              id="settings-stt-language"
              onChange={(event) => onChange({ ...stt, language: event.target.value === '' ? null : event.target.value })}
              placeholder="Detect"
              value={stt.language ?? ''}
            />
            <span className="field-hint">Leave blank to detect.</span>
          </div>
          <div className="settings-test-row">
            <button className="btn btn-sm" disabled={testPending} onClick={() => void testConnection()} type="button">
              Test connection
            </button>
            <ConnectionStatus pending={testPending} result={testResult} />
          </div>
        </>
      )}
    </section>
  );
}
