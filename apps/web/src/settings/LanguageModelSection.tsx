import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { LlmModel } from '@latentpresence/protocol';
import { browserAccess } from '@latentpresence/providers/web';
import { ConnectionStatus } from './ConnectionStatus';
import {
  messageForProbe,
  resolveTransport,
  runTestMessage,
  type ConnectionResult,
  type TestMessageResult,
} from './connection';
import type { SettingsDeps } from './deps';
import {
  LLM_ENDPOINT_OPTIONS,
  buildLlmProvider,
  chattableModels,
  defaultBaseUrlFor,
  endpointLabel,
  endpointNeedsKeyField,
  listingFor,
  probeContextFor,
} from './llm-endpoint';
import { KeyField } from './KeyField';
import { llmKeyRef, type LlmSettings } from './settings';

export interface LanguageModelSectionProps {
  readonly llm: LlmSettings;
  readonly companionUrl: string;
  readonly onChangeLlm: (patch: Partial<LlmSettings>) => void;
  readonly onChangeCompanionUrl: (url: string) => void;
  readonly deps: SettingsDeps;
}

const TEST_MESSAGE = 'Reply with one word: ready';

export function LanguageModelSection({ llm, companionUrl, onChangeLlm, onChangeCompanionUrl, deps }: LanguageModelSectionProps): ReactElement {
  const [testPending, setTestPending] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionResult | null>(null);
  const [models, setModels] = useState<readonly LlmModel[]>([]);

  const [messagePending, setMessagePending] = useState(false);
  const [messageResult, setMessageResult] = useState<TestMessageResult | null>(null);
  const [streamedText, setStreamedText] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const startRef = useRef(0);

  useEffect(() => {
    if (!messagePending) return;
    const id = window.setInterval(() => setElapsed((deps.now() - startRef.current) / 1000), 100);
    return () => window.clearInterval(id);
  }, [messagePending, deps]);

  const option = llm.endpoint === null ? null : LLM_ENDPOINT_OPTIONS.find((candidate) => (candidate.kind === 'preset' ? candidate.id : candidate.kind) === llm.endpoint) ?? null;
  const access = llm.endpoint === null ? null : browserAccess(llm.endpoint);
  const hasCustomBaseUrl = llm.endpoint !== null && llm.endpoint !== 'anthropic' && llm.endpoint !== 'google';
  const chattable = chattableModels(models);
  const capabilitiesUnknown = models.some((model) => model.capabilities === null);
  const messageTone: 'ok' | 'danger' = messageResult?.outcome === 'replied' ? 'ok' : 'danger';

  function selectEndpoint(id: string): void {
    if (id === '') {
      onChangeLlm({ endpoint: null, modelId: null });
    } else {
      onChangeLlm({ endpoint: id, baseUrl: defaultBaseUrlFor(id) ?? '', modelId: null });
    }
    setTestResult(null);
    setModels([]);
    setMessageResult(null);
  }

  async function testConnection(): Promise<void> {
    const endpointId = llm.endpoint;
    if (endpointId === null) return;
    setTestPending(true);
    setTestResult(null);
    setModels([]);
    try {
      const apiKey = await deps.vault.loadKey(llmKeyRef(endpointId));
      const transport = await resolveTransport({
        endpointId,
        companionUrl,
        origin: deps.origin,
        fetch: deps.fetch,
        probe: deps.probe,
      });
      if (!transport.ok) {
        setTestResult(transport.result);
        return;
      }
      const { url, headers } = listingFor(endpointId, llm.baseUrl, apiKey);
      const probe = await deps.probe(url, { fetch: transport.fetch, headers });
      const message = messageForProbe(probe, probeContextFor(endpointId, url, deps.origin, apiKey !== null));
      if (message.tone !== 'ok') {
        setTestResult(message);
        return;
      }
      const provider = buildLlmProvider(endpointId, llm.baseUrl, apiKey, transport.fetch);
      const listed = await provider.listModels();
      setModels(listed);
      setTestResult({ ...message, text: `${message.text} ${listed.length} model${listed.length === 1 ? '' : 's'}.` });
    } catch (error) {
      setTestResult({ tone: 'danger', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setTestPending(false);
    }
  }

  async function sendTestMessage(): Promise<void> {
    const endpointId = llm.endpoint;
    const modelId = llm.modelId;
    if (endpointId === null || modelId === null) return;
    setMessageResult(null);
    setStreamedText('');
    startRef.current = deps.now();
    setElapsed(0);
    setMessagePending(true);
    try {
      const apiKey = await deps.vault.loadKey(llmKeyRef(endpointId));
      const transport = await resolveTransport({ endpointId, companionUrl, origin: deps.origin, fetch: deps.fetch, probe: deps.probe });
      if (!transport.ok) {
        setMessageResult({ outcome: 'error', text: '', seconds: 0, message: transport.result.text });
        return;
      }
      const provider = buildLlmProvider(endpointId, llm.baseUrl, apiKey, transport.fetch);
      const controller = new AbortController();
      abortRef.current = controller;
      const stream = provider.stream(
        { modelId, messages: [{ role: 'user', content: TEST_MESSAGE }], tools: [], temperature: llm.temperature, maxOutputTokens: null },
        { signal: controller.signal },
      );
      const result = await runTestMessage(stream, deps.now, setStreamedText);
      setMessageResult(result);
    } catch (error) {
      setMessageResult({ outcome: 'error', text: '', seconds: (deps.now() - startRef.current) / 1000, message: error instanceof Error ? error.message : String(error) });
    } finally {
      setMessagePending(false);
      abortRef.current = null;
    }
  }

  function cancelTestMessage(): void {
    abortRef.current?.abort();
  }

  return (
    <section className="panel settings-section">
      <div className="panel-header">
        <span className="panel-title">Language model</span>
      </div>

      <div className="field">
        <label className="field-label" htmlFor="settings-llm-endpoint">
          Endpoint
        </label>
        <select className="select" id="settings-llm-endpoint" onChange={(event) => selectEndpoint(event.target.value)} value={llm.endpoint ?? ''}>
          <option value="">Choose an endpoint…</option>
          {LLM_ENDPOINT_OPTIONS.map((candidate) => {
            const id = candidate.kind === 'preset' ? candidate.id : candidate.kind;
            return (
              <option key={id} value={id}>
                {candidate.kind === 'preset' ? candidate.label : endpointLabel(candidate.kind)}
              </option>
            );
          })}
        </select>
      </div>

      {hasCustomBaseUrl && llm.endpoint !== null && (
        <div className="field">
          <label className="field-label" htmlFor="settings-llm-base-url">
            Base URL
          </label>
          <input
            className="input"
            id="settings-llm-base-url"
            onChange={(event) => onChangeLlm({ baseUrl: event.target.value })}
            value={llm.baseUrl}
          />
        </div>
      )}

      {llm.endpoint !== null && endpointNeedsKeyField(llm.endpoint) && (
        <KeyField
          // A fresh field per endpoint: switching presets must not carry a previous
          // endpoint's "saved" state over (see KeyField's own doc comment).
          key={llmKeyRef(llm.endpoint)}
          hint={option?.kind === 'preset' ? option.hint : null}
          id="settings-llm-key"
          label="API key"
          onChange={() => setTestResult(null)}
          optional={llm.endpoint === 'custom'}
          refKey={llmKeyRef(llm.endpoint)}
          vault={deps.vault}
        />
      )}

      {access === 'local-cors' && (
        <p className="field-hint">This server may need CORS turned on before this page can reach it.</p>
      )}
      {access === 'relay' && (
        <>
          <p className="field-hint">Calls go through the companion on this computer.</p>
          <div className="field">
            <label className="field-label" htmlFor="settings-companion-url">
              Companion URL
            </label>
            <input
              className="input"
              id="settings-companion-url"
              onChange={(event) => onChangeCompanionUrl(event.target.value)}
              value={companionUrl}
            />
          </div>
        </>
      )}

      {llm.endpoint !== null && (
        <div className="settings-test-row">
          <button className="btn btn-sm" disabled={testPending} onClick={() => void testConnection()} type="button">
            Test connection
          </button>
          <ConnectionStatus pending={testPending} result={testResult} />
        </div>
      )}

      {llm.endpoint !== null && (
        <div className="field">
          <label className="field-label" htmlFor="settings-llm-model">
            Model
          </label>
          <select
            className="select"
            disabled={chattable.length === 0 && llm.modelId === null}
            id="settings-llm-model"
            onChange={(event) => onChangeLlm({ modelId: event.target.value === '' ? null : event.target.value })}
            value={llm.modelId ?? ''}
          >
            <option value="">Choose a model…</option>
            {/* After a reload the list is empty until the next test, but the saved choice
                still stands and must not read as "nothing chosen". */}
            {llm.modelId !== null && !chattable.some((model) => model.id === llm.modelId) && (
              <option value={llm.modelId}>{llm.modelId}</option>
            )}
            {chattable.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </select>
          {capabilitiesUnknown && <span className="field-hint">Capabilities unknown for models from this endpoint.</span>}
        </div>
      )}

      <div className="field">
        <span className="field-label">Temperature</span>
        <div className="settings-temperature-row">
          <label>
            <input
              checked={llm.temperature === null}
              onChange={(event) => onChangeLlm({ temperature: event.target.checked ? null : 0.7 })}
              type="checkbox"
            />
            {' '}Server default
          </label>
          <input
            aria-label="Temperature"
            disabled={llm.temperature === null}
            max={1.5}
            min={0.1}
            onChange={(event) => onChangeLlm({ temperature: Number(event.target.value) })}
            step={0.1}
            type="range"
            value={llm.temperature ?? 0.7}
          />
          <span className="field-hint">{llm.temperature === null ? 'Server default' : llm.temperature.toFixed(1)}</span>
        </div>
      </div>

      {llm.endpoint !== null && (
        <div className="field">
          <div className="settings-test-row">
            <button
              className="btn btn-primary btn-sm"
              disabled={llm.modelId === null || messagePending}
              onClick={() => void sendTestMessage()}
              type="button"
            >
              Send a test message
            </button>
            {messagePending && (
              <>
                <span className="settings-elapsed">{elapsed.toFixed(1)} s</span>
                <button className="btn btn-sm btn-ghost" onClick={cancelTestMessage} type="button">
                  Cancel
                </button>
              </>
            )}
          </div>
          <div aria-live="polite" className="settings-status-region">
            {messagePending && streamedText !== '' && <p className="settings-message-output">{streamedText}</p>}
            {!messagePending && messageResult !== null && (
              <>
                {/* `messageTone` is a bare identifier in the template below, never a
                    literal — see the note in ConnectionStatus.tsx. */}
                <p className={`settings-status settings-status-${messageTone}`}>{messageResult.message}</p>
                {messageResult.outcome === 'replied' && <p className="settings-message-output">{messageResult.text}</p>}
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
