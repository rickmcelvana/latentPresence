import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import {
  ConversationMachine,
  Reply,
  TurnDetector,
  VoiceSession,
  type PlaybackSink,
} from '@latentpresence/core';
import { createGatedVadWorker, sileroVadModel } from '@latentpresence/ml-web';
import type { ConversationEvent } from '@latentpresence/protocol';
import {
  BrowserSileroVad,
  FakeLLMProvider,
  FakeTTSProvider,
  createAudioOutput,
  microphoneSource,
  startCapture,
  type AudioOutputHandle,
  type CaptureHandle,
} from '@latentpresence/providers';
import { defaultModelConsent } from '../consent/deps';

/**
 * `/dev/e2e` — the page P1-T14's Playwright test drives.
 *
 * **Deliberately not `/dev/voice`.** That page is an instrument for a person: it downloads
 * 473 MB of models, needs WebGPU, and has controls whose whole point is being fiddled with.
 * A CI test wants none of that. This page is the same *wiring* with the expensive halves
 * replaced, so what it proves is the part CI can actually break.
 *
 * **What is real here**, because it is what a browser can get wrong and a unit test cannot
 * see: `getUserMedia`, the capture `AudioWorklet`, **Silero** (2.2 MB of wasm, no GPU),
 * `TurnDetector`, `ConversationMachine`, `Reply`, `BargeInGate`, the playback
 * `AudioWorklet`, and **the consent gate** — Silero does not load until Agree is clicked,
 * which is the browser proof P1-T13 owed.
 *
 * **What is faked, and why each one:** the language model (a network call, and
 * nondeterministic), synthesis (Kokoro is 325 MB and needs WebGPU), and recognition
 * (Moonshine is ~50 MB and would make the assertions depend on a transcription). Smart Turn
 * is simply absent — `TurnDetector` takes no judge here, so turns end on the hangover, which
 * is deterministic and costs no 8.7 MB download.
 *
 * Everything worth asserting is published on `window.e2eHandle`; the page renders almost
 * nothing, because nothing looks at it.
 */

const ANSWER =
  'This is a long answer, said slowly, so that the next thing the microphone hears lands while it is still playing. ' +
  'It keeps going for a while on purpose. There is no meaning in these words, only duration.';
const HEARD = 'what time is it';

/** What the Playwright spec reads. Nothing else uses it. */
export interface E2EHandle {
  readonly states: string[];
  readonly events: { type: string; text?: string; spokenPrefix?: string }[];
  status: string;
  error: string | null;
  /** True once the session is listening to the fake microphone. */
  listening: boolean;
}

declare global {
  /** The spec's only window into this page. Named without leading underscores because
   * oxlint rejects those, not because it is meant to look like ordinary app state. */
  // eslint-disable-next-line no-var
  var e2eHandle: E2EHandle | undefined;
}

function freshHandle(): E2EHandle {
  return { states: [], events: [], status: 'idle', error: null, listening: false };
}

export function E2EPage(): ReactElement {
  const [status, setStatus] = useState('idle');
  const started = useRef(false);
  const cleanup = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    globalThis.e2eHandle = freshHandle();
    return () => {
      void cleanup.current?.();
    };
  }, []);

  function note(next: string): void {
    setStatus(next);
    if (globalThis.e2eHandle !== undefined) globalThis.e2eHandle.status = next;
  }

  /**
   * Agree, then build. The ordering is the assertion P1-T13 owed a browser for: nothing
   * calls `createGatedVadWorker` until consent has been granted, so a test that asserts on
   * the request log sees no weights fetched before this click.
   */
  async function agreeAndStart(): Promise<void> {
    if (started.current) return;
    started.current = true;
    const handle = globalThis.e2eHandle ?? freshHandle();
    globalThis.e2eHandle = handle;
    try {
      note('granting consent');
      const consent = defaultModelConsent();
      consent.grant([sileroVadModel()]);

      note('opening audio');
      const audio: AudioOutputHandle = await createAudioOutput();
      const sink: PlaybackSink = {
        enqueue: (segment) => audio.output.enqueue(segment),
        duck: () => audio.output.duck(),
        unduck: () => audio.output.unduck(),
        fadeOut: (ms) => audio.output.fadeOut(ms),
        position: () => audio.output.position(),
        subscribe: (listener) => audio.output.subscribe(listener),
      };

      const machine = new ConversationMachine({
        sessionId: 'e2e',
        characterId: 'alice',
        fadeOutMs: 100,
        ports: { audioOut: sink },
      });
      machine.subscribe((event: ConversationEvent) => {
        if (event.type === 'state.changed') handle.states.push(event.to);
        handle.events.push({
          type: event.type,
          ...(event.type === 'user.transcript' ? { text: event.text } : {}),
          ...(event.type === 'assistant.interrupted' ? { spokenPrefix: event.spokenPrefix } : {}),
        });
      });

      note('loading Silero');
      const vad = new BrowserSileroVad({ createWorker: () => createGatedVadWorker(consent) });
      await vad.load();

      const llm = new FakeLLMProvider('e2e', {
        script: [
          ...ANSWER.split(/(?<= )/u).map((text) => ({ type: 'text-delta', text }) as const),
          { type: 'finish', reason: 'stop', usage: null },
        ],
      });
      // 40 ms a character makes the answer roughly eight seconds of audio, so the fake
      // microphone's next burst of speech is certain to land while it is still playing.
      // Barge-in is then a fact about the wiring rather than a race the CI machine can lose.
      const tts = new FakeTTSProvider('e2e', { msPerChar: 40 });

      const detector = new TurnDetector<string>({
        now: () => performance.now(),
        recognise: () => HEARD,
      });

      const session = new VoiceSession<string>({
        sessionId: 'e2e',
        machine,
        detector,
        sink,
        transcribe: async (recognition) => (await recognition) ?? HEARD,
        respond: (turn, replyOptions) =>
          new Reply(
            {
              modelId: 'e2e',
              messages: [...turn.messages],
              tools: [],
              temperature: null,
              maxOutputTokens: null,
            },
            { llm, tts, sink, voiceId: 'fake' },
            replyOptions,
          ),
      });
      vad.onFrame((frame) => session.push(frame));
      machine.start();

      note('opening the microphone');
      const capture: CaptureHandle = await startCapture(microphoneSource, (samples, at) => vad.push(samples, at));

      cleanup.current = async () => {
        await capture.stop();
        session.dispose();
        vad.terminate();
        await audio.close();
      };
      handle.listening = true;
      note(`listening: ${capture.deviceLabel}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (globalThis.e2eHandle !== undefined) globalThis.e2eHandle.error = message;
      note(`failed: ${message}`);
    }
  }

  return (
    <main className="e2e-page">
      <h1>End-to-end harness</h1>
      <p className="e2e-note">
        Dev-only, and driven by Playwright (P1-T14). Real microphone, capture and playback worklets, Silero, turn
        detection, machine, reply and barge-in; the model, the voice and recognition are fakes.
      </p>
      <button className="btn btn-primary" data-testid="agree" onClick={() => void agreeAndStart()} type="button">
        Agree and start
      </button>
      <p className="e2e-status" data-testid="status">
        {status}
      </p>
    </main>
  );
}
