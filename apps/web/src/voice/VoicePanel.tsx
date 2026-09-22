import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { ConversationHistory, ConversationMachine } from '@latentpresence/core';
import type { LLMProvider } from '@latentpresence/protocol';
import { ConsentScreen } from '../consent/ConsentScreen';
import type { SettingsDeps } from '../settings/deps';
import type { Settings } from '../settings/settings';
import { VoiceCall, type VoiceCallOptions } from './call';
import { browserModelsFor } from './models';
import { buildSpeechProviders } from './providers';

/**
 * Voice on `/chat` (P1-T15): the consent screen, then a call.
 *
 * Four states, and each one exists because the one before it can fail:
 *
 * - **idle** — a button, and a hint naming what will be downloaded.
 * - **consent** — `ConsentScreen` (P1-T13) with exactly `browserModelsFor(settings)`, shown
 *   before anything fetches. The list follows `/settings`, so a server voice and a server
 *   hearing leave only the two turn models.
 * - **starting** — models loading. Slow on purpose to look at: Kokoro `fp32` is 325 MB.
 * - **active** — the machine's state, the microphone it opened, and End call.
 *
 * The transcript is not here. Every event a spoken turn produces goes on the same machine
 * `/chat` already reads, so the panel beside it fills itself and a typed message and a
 * spoken one sit in one conversation, in order.
 *
 * **`stop()` is called on unmount as well as on End call.** React 19's StrictMode runs a
 * mount-time cleanup in development, so this must be harmless when nothing started — and
 * it is: `VoiceCall.stop` is idempotent and the cleanup closes over the call that exists.
 */

/** What the panel needs from a running call. `VoiceCall` satisfies it; a test hands over an
 * object with no audio graph behind it. */
export interface ActiveCall {
  readonly inputLabel: string | null;
  stop(): Promise<void>;
}

export interface VoicePanelProps {
  readonly machine: ConversationMachine;
  readonly history: ConversationHistory;
  readonly llm: LLMProvider;
  readonly modelId: string;
  readonly temperature: number | null;
  readonly settings: Settings;
  readonly deps: SettingsDeps;
  /** Whether a call is running, so `/chat` can put the keyboard away while it is. */
  readonly onActive: (active: boolean) => void;
  /** Leave voice and go back to typing. The panel is unmounted by the caller. */
  readonly onEnd: () => void;
  /** Test seams. Production passes neither. */
  readonly startCall?: (options: VoiceCallOptions) => Promise<ActiveCall>;
  readonly buildSpeech?: typeof buildSpeechProviders;
}

type Phase = 'idle' | 'consent' | 'starting' | 'active';

export function VoicePanel({
  machine,
  history,
  llm,
  modelId,
  temperature,
  settings,
  deps,
  onActive,
  onEnd,
  startCall,
  buildSpeech = buildSpeechProviders,
}: VoicePanelProps): ReactElement {
  const [phase, setPhase] = useState<Phase>('idle');
  const [status, setStatus] = useState('Nothing has been downloaded yet.');
  const [state, setState] = useState(machine.getState());
  const call = useRef<ActiveCall | null>(null);
  // This browser's consent book, from the shared deps bag — the same object
  // `/settings`'s Downloaded-models section reads and revokes, so agreeing here is visible
  // there and revoking there asks again here. A test hands over a memory-backed one.
  const consent = deps.consent;
  const models = useMemo(() => browserModelsFor(settings), [settings]);

  useEffect(() => machine.subscribe((event) => {
    if (event.type === 'state.changed') setState(event.to);
  }), [machine]);

  useEffect(
    () => () => {
      // A call outliving the panel would leave a microphone open and a 325 MB worker
      // running. `onActive(false)` too: a panel that vanished without saying so would
      // leave `/chat` with a permanently disabled text box.
      void call.current?.stop();
      call.current = null;
      onActive(false);
    },
    [onActive],
  );

  const begin = useCallback(async () => {
    setPhase('starting');
    try {
      const speech = await buildSpeech(settings, deps, consent);
      const active = await (startCall ?? VoiceCall.start)({
        machine,
        history,
        llm,
        modelId,
        temperature,
        speech,
        consent,
        voiceId: settings.tts.voiceId,
        speed: settings.tts.speed,
        log: (line) => setStatus(line),
      });
      call.current = active;
      setStatus(`Listening on ${active.inputLabel ?? 'the microphone'}.`);
      setPhase('active');
      onActive(true);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      setPhase('idle');
    }
  }, [buildSpeech, consent, deps, history, llm, machine, modelId, onActive, settings, startCall, temperature]);

  async function end(): Promise<void> {
    await call.current?.stop();
    call.current = null;
    onActive(false);
    onEnd();
  }

  /**
   * The consent screen appears only when something is actually ungranted, and it is the
   * whole panel when it does — a start button beside it would be a second way to fetch the
   * same weights without agreeing.
   */
  function requestStart(): void {
    if (consent.has(models)) void begin();
    else setPhase('consent');
  }

  if (phase === 'consent') {
    return (
      <ConsentScreen
        descriptors={models}
        onAgree={() => {
          consent.grant(models);
          void begin();
        }}
        onCancel={onEnd}
      />
    );
  }

  // Chosen outside the template literal so `theme.test.ts`'s scanner does not read a state
  // name as a class name — it harvests the string literals inside `${…}`.
  const statePill = state === 'speaking' ? 'pill-accent' : 'pill-ok';

  return (
    <section className="panel voice-panel">
      <div className="panel-header">
        <span className="panel-title">Voice</span>
        {phase === 'active' && <span className={`pill ${statePill}`}>{state}</span>}
        {phase === 'starting' && <span className="pill pill-warn">loading models</span>}
      </div>

      {phase === 'idle' && (
        <>
          <p className="voice-status">{status}</p>
          <div className="voice-controls">
            <button className="btn btn-primary" onClick={requestStart} type="button">
              Start voice
            </button>
            <button className="btn btn-ghost" onClick={onEnd} type="button">
              Cancel
            </button>
          </div>
          <p className="field-hint">
            A browser voice and hearing download their models the first time a call starts, once you agree — nothing is
            fetched from this page. A server set in Settings downloads nothing.
          </p>
        </>
      )}

      {phase === 'starting' && (
        <>
          <p className="voice-status">{status}</p>
          <div className="voice-controls">
            <button className="btn btn-ghost" disabled type="button">
              Loading…
            </button>
          </div>
        </>
      )}

      {phase === 'active' && (
        <>
          {/* The last line the call logged — the microphone it opened, then whatever the
              turn models had to say while it was starting. */}
          <p className="voice-status">{status}</p>
          <div className="voice-controls">
            <button className="btn btn-danger" onClick={() => void end()} type="button">
              End call
            </button>
            <span className="field-hint">Speak whenever you like. Talking over the answer cuts it at the word you heard.</span>
          </div>
        </>
      )}
    </section>
  );
}
