import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { ConversationHistory, ConversationMachine } from '@latentpresence/core';
import type { LLMProvider } from '@latentpresence/protocol';
import type { AudioOutputHandle } from '@latentpresence/providers';
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
 * **It must also not run because a prop changed** — see `activeListener`, which is that
 * bug's fix and its explanation.
 */

/** What the panel needs from a running call. `VoiceCall` satisfies it; a test hands over an
 * object with no audio graph behind it.
 *
 * `output` and `setMuted` are optional for exactly that reason (P2-T06): a test's fake
 * call has no audio graph to hand over and nothing to mute, and `VoiceCall` supplies both
 * for real. `CallStage` reads `output` to tap the voice for lip sync, and the controls
 * bar's Mute button calls `setMuted` when it exists. */
export interface ActiveCall {
  readonly inputLabel: string | null;
  readonly output?: AudioOutputHandle;
  setMuted?(muted: boolean): void;
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
  /** Her mood in her voice (P3-T09), passed to the call's replies. Should be a stable identity. */
  readonly voiceStyle?: VoiceCallOptions['voiceStyle'];
  /** Whether a call is running, so `/chat` can put the keyboard away while it is. */
  readonly onActive: (active: boolean) => void;
  /** Leave voice and go back to typing. The panel is unmounted by the caller. */
  readonly onEnd: () => void;
  /** The call itself, the moment it starts (P2-T06) — `CallStage` needs it for lip sync
   * (`call.output`) and the controls bar's Mute button (`call.setMuted`), neither of
   * which `onActive`'s boolean carries. Called with `null` when the call ends, so the
   * caller can drop its reference and stop asking a dead call to do anything. */
  readonly onCallStarted?: (call: ActiveCall | null) => void;
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
  voiceStyle,
  onActive,
  onEnd,
  onCallStarted,
  startCall,
  buildSpeech = buildSpeechProviders,
}: VoicePanelProps): ReactElement {
  const [phase, setPhase] = useState<Phase>('idle');
  const [status, setStatus] = useState('Nothing has been downloaded yet.');
  const [state, setState] = useState(machine.getState());
  const call = useRef<ActiveCall | null>(null);
  /**
   * `onActive` behind a ref, and the teardown effect below with **no dependencies**.
   *
   * **This is a bug that shipped and reached a person** (2026-09-22). `/chat` passed
   * `onActive` as an inline arrow — the obvious thing to write — so every re-render gave it
   * a new identity. The teardown effect depended on it, React ran the cleanup when the
   * identity changed, and the cleanup stops the call. The panel then still said "Listening
   * on <microphone>" in the `active` phase while the VAD, the capture and the audio graph
   * had been torn down, so `/chat` looked like a connected microphone that never heard
   * anything, while `/dev/voice` (which owns its pipeline outside React) was fine.
   *
   * A prop changing identity is never a reason to drop a call, so the two are separated: a
   * prop update writes the ref, and only an actual unmount runs the teardown.
   */
  const activeListener = useRef(onActive);
  /** Same ref-not-dependency shape as `activeListener`, and the same reason: `onCallStarted`
   * is exactly as likely to arrive as a fresh inline arrow from `/chat` on every render. */
  const callStartedListener = useRef(onCallStarted);

  useEffect(() => {
    activeListener.current = onActive;
  }, [onActive]);

  useEffect(() => {
    callStartedListener.current = onCallStarted;
  }, [onCallStarted]);
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
      // running. `activeListener` too: a panel that vanished without saying so would leave
      // `/chat` with a permanently disabled text box. Neither is a dependency of this
      // effect — see `activeListener` above for why that distinction is load-bearing.
      void call.current?.stop();
      call.current = null;
      activeListener.current(false);
      callStartedListener.current?.(null);
    },
    [],
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
        ...(voiceStyle === undefined ? {} : { voiceStyle }),
        log: (line) => setStatus(line),
      });
      call.current = active;
      setStatus(`Listening on ${active.inputLabel ?? 'the microphone'}.`);
      setPhase('active');
      onActive(true);
      callStartedListener.current?.(active);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      setPhase('idle');
    }
  }, [buildSpeech, consent, deps, history, llm, machine, modelId, onActive, settings, startCall, temperature, voiceStyle]);

  async function end(): Promise<void> {
    await call.current?.stop();
    call.current = null;
    onActive(false);
    callStartedListener.current?.(null);
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
