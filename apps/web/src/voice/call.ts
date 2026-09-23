import {
  Reply,
  TurnDetector,
  VoiceSession,
  prepareBackchannels,
  type BackchannelClip,
  type ConversationHistory,
  type ConversationMachine,
  type PlaybackSink,
  type VadFrame,
} from '@latentpresence/core';
import type { ModelConsent } from '@latentpresence/ml-web/consent';
import { createGatedSmartTurnWorker, createGatedVadWorker } from '@latentpresence/ml-web';
import type { CancellationSignal, LLMProvider, STTProvider, SttResult, TTSProvider } from '@latentpresence/protocol';
import {
  BrowserSileroVad,
  SmartTurnJudge,
  createAudioOutput,
  microphoneSource,
  speculativeTranscription,
  startCapture,
  type AudioOutputHandle,
  type CaptureHandle,
} from '@latentpresence/providers';
import type { SpeechProviders } from './providers';

/**
 * The voice loop in the product (P1-T15).
 *
 * Everything here is already built and measured — `VoiceSession` decides what counts, the
 * two-stage barge-in sits in the middle, ADR-25 holds a provisional turn's audio, ADR-28's
 * backchannels play into the pauses — and **none of it had ever been reachable by a user**:
 * `/dev/voice` is dropped from production builds and `/chat` was typed only. This is the
 * same wiring `apps/web/src/dev/voice-pipeline.ts` runs, with the harness parts taken out
 * (no simulated speaker, no measurement tables, no scripted model) and the provider choice
 * taken from `/settings` instead of hard-coded.
 *
 * **What it deliberately does not own:** the machine and the conversation history. Both
 * come in from `/chat`, because a typed message and a spoken turn have to be one
 * conversation (P1-T12b) — a call that made its own would answer every spoken turn as if
 * the typed ones had never happened, which is exactly the defect R-6 found.
 *
 * The pieces it does own are the ones a call is: the output graph, the microphone, Silero,
 * Smart Turn, the detector, and the session tying them together. `stop()` disposes the
 * speech providers too, so a caller cannot end a call and leave a 325 MB worker running.
 */

/** ADR-26: duck on the first speech frame, commit after 200 ms of speech. */
export const BARGE_IN_MS = 200;

/** One short word, synthesised and thrown away. Loading Kokoro is ~1 s and the first
 * sentence would otherwise pay it inside the turn the user is waiting on. */
const WARM_TEXT = 'Ready.';

/**
 * The two turn pieces, as this module uses them.
 *
 * Interfaces rather than the concrete classes so a test can drive a call with a scripted
 * probability stream and a judge that answers immediately — the alternative is a worker, a
 * WebGPU adapter and 35 MB of weights in a jsdom process. `BrowserSileroVad` and
 * `SmartTurnJudge` satisfy both structurally, and they are what production builds.
 */
export interface VadLike {
  load(): Promise<void>;
  /** One 16 kHz frame from the microphone. */
  push(samples: Float32Array, at: number): void;
  onFrame(listener: (frame: VadFrame) => void): () => void;
  onError(listener: (error: Error) => void): () => void;
  terminate(): void;
}

export interface JudgeLike {
  load(): Promise<void>;
  judge(audio: Float32Array, signal: CancellationSignal): Promise<number>;
  terminate(): void;
}

export interface VoiceCallOptions {
  readonly machine: ConversationMachine;
  /** Already attached to `machine` (`attachHistory`), and the same one `/chat` keeps. */
  readonly history: ConversationHistory;
  readonly llm: LLMProvider;
  readonly modelId: string;
  readonly temperature: number | null;
  readonly speech: SpeechProviders;
  /** Must already cover `browserModelsFor(settings)`, or `requireConsent` throws here. */
  readonly consent: ModelConsent;
  readonly voiceId: string;
  readonly speed: number;
  readonly sessionId?: string;
  /** ADR-28's clips. Off: the character never backchannels. Default on. */
  readonly backchannels?: boolean;
  readonly log?: (line: string) => void;
  /** Test seams. Production never passes any of them — the defaults are the real ones. */
  readonly createAudio?: () => Promise<AudioOutputHandle>;
  readonly capture?: typeof startCapture;
  readonly createVad?: () => VadLike;
  readonly createJudge?: () => JudgeLike;
}

async function synthesizeAndDiscard(tts: TTSProvider, text: string, voiceId: string): Promise<number> {
  let samples = 0;
  for await (const chunk of tts.synthesize({ text, voiceId, speed: 1, hint: null })) {
    samples += chunk.samples.length;
  }
  return samples;
}

/**
 * Pay a browser recogniser's load cost now rather than inside the first turn.
 *
 * Only browser ones: a server would answer a request that transcribes a second of silence,
 * which costs money and proves nothing. The padding is the one `docs/SURFACE.md` records —
 * **Moonshine only emits its end token with silence after the last word**, so a bare
 * second of silence can come back as an empty result that never finishes.
 */
async function warmRecognition(stt: STTProvider): Promise<void> {
  const capabilities = await stt.capabilities();
  if (!capabilities.runsInBrowser) return;
  const silence = new Float32Array(16_000 + 4_800 + 8_000);
  async function* once() {
    yield { samples: silence, sampleRate: 16_000, startMs: 0 };
  }
  for await (const result of stt.transcribe(once())) {
    if (result.isFinal) break;
  }
}

export class VoiceCall {
  private readonly options: VoiceCallOptions;
  private readonly audio: AudioOutputHandle;
  private readonly vad: VadLike;
  private readonly judge: JudgeLike;
  private readonly session: VoiceSession<Promise<SttResult | null>>;
  private readonly capture: CaptureHandle | null;
  /** A mutable box rather than a field the capture callback closes over `this` to read:
   * the callback is built in `start()`, before the instance exists (the constructor is
   * private and runs last), so `setMuted` writes through the same box the callback reads. */
  private readonly mutedBox: { current: boolean };
  private stopped = false;

  private constructor(
    options: VoiceCallOptions,
    audio: AudioOutputHandle,
    vad: VadLike,
    judge: JudgeLike,
    session: VoiceSession<Promise<SttResult | null>>,
    capture: CaptureHandle | null,
    mutedBox: { current: boolean },
  ) {
    this.options = options;
    this.audio = audio;
    this.vad = vad;
    this.judge = judge;
    this.session = session;
    this.capture = capture;
    this.mutedBox = mutedBox;
  }

  /** What the microphone calls itself, for the call bar. */
  get inputLabel(): string | null {
    return this.capture?.deviceLabel ?? null;
  }

  /** The output graph's context and worklet node, for the call layout's lip sync
   * (`tapAnalyser`, P2-T06). Not optional here — `VoicePanel`'s `ActiveCall` seam is
   * where it becomes optional, for a test call with no audio graph behind it. */
  get output(): AudioOutputHandle {
    return this.audio;
  }

  /**
   * Stop, or resume, feeding microphone frames to the VAD (P2-T06, decision 6). The
   * microphone itself stays open throughout — muting is "the VAD hears nothing", not "the
   * capture is stopped and restarted" — so a muted call still costs nothing to unmute and
   * never re-triggers a permission prompt. Because the VAD sees no speech while muted,
   * barge-in and backchannel both fall out for free: `VoiceSession` never gets a frame
   * that looks like the user starting to talk.
   */
  setMuted(muted: boolean): void {
    this.mutedBox.current = muted;
  }

  /**
   * Build the graph and start listening. **Call from a click**: the autoplay policy leaves
   * an `AudioContext` created without a gesture suspended, and a suspended context renders
   * nothing — the character would answer into silence.
   */
  static async start(options: VoiceCallOptions): Promise<VoiceCall> {
    const { machine, log } = options;
    const createAudio = options.createAudio ?? createAudioOutput;
    const captureWith = options.capture ?? startCapture;

    const audio = await createAudio();
    const sink: PlaybackSink = {
      enqueue: (segment) => audio.output.enqueue(segment),
      duck: () => audio.output.duck(),
      unduck: () => audio.output.unduck(),
      fadeOut: (ms) => audio.output.fadeOut(ms),
      position: () => audio.output.position(),
      subscribe: (listener) => audio.output.subscribe(listener),
    };

    const vad = (options.createVad ?? ((): VadLike => new BrowserSileroVad({ createWorker: () => createGatedVadWorker(options.consent) })))();
    const judge = (options.createJudge ??
      ((): JudgeLike => new SmartTurnJudge({ createWorker: () => createGatedSmartTurnWorker(options.consent, 'gpu') })))();

    const { speech } = options;
    const { voiceId, speed } = options;
    let clips: readonly BackchannelClip[] = [];
    try {
      const turnModelsAt = performance.now();
      await Promise.all([vad.load(), judge.load()]);
      log?.(`turn detection ready in ${Math.round(performance.now() - turnModelsAt)} ms`);

      const warmAt = performance.now();
      await synthesizeAndDiscard(speech.tts, WARM_TEXT, voiceId);
      log?.(`voice ready in ${Math.round(performance.now() - warmAt)} ms`);
      await warmRecognition(speech.stt);

      if (options.backchannels !== false) {
        const clipsAt = performance.now();
        clips = await prepareBackchannels(speech.tts, { voiceId, speed });
        log?.(`backchannels ready in ${Math.round(performance.now() - clipsAt)} ms`);
      }
    } catch (error) {
      // Nothing is playing yet and no microphone is open, so failing here is only a
      // message. The caller shows it and the user can fix `/settings` and try again.
      vad.terminate();
      judge.terminate();
      speech.dispose();
      await audio.close();
      throw error;
    }

    const detector = new TurnDetector<Promise<SttResult | null>>({
      now: () => performance.now(),
      judge,
      recognise: speculativeTranscription(speech.stt),
    });

    const session = new VoiceSession<Promise<SttResult | null>>({
      sessionId: options.sessionId ?? 'chat',
      machine,
      detector,
      sink,
      bargeIn: { bargeInMs: BARGE_IN_MS },
      ...(clips.length === 0 ? {} : { backchannel: { clips, overlap: 'duck' as const } }),
      // A history this call did not make, already watching the bus: passing it is what
      // makes the model answer in the light of what was typed as well as what was said.
      history: options.history,
      transcribe: async (recognition) => (await recognition)?.text ?? null,
      respond: (turn, replyOptions) =>
        new Reply(
          {
            modelId: options.modelId,
            // The conversation so far, `system` first and this turn last (P1-T12b).
            messages: [...turn.messages],
            tools: [],
            temperature: options.temperature,
            maxOutputTokens: null,
          },
          { llm: options.llm, tts: speech.tts, sink, voiceId, speed },
          replyOptions,
        ),
    });
    vad.onFrame((frame) => session.push(frame));
    vad.onError((error) => log?.(`hearing failed: ${error.message}`));

    // `setMuted` writes this after the instance exists; the capture callback is built
    // now, before it does, so both read and write go through the same box.
    const mutedBox = { current: false };
    let capture: CaptureHandle | null = null;
    try {
      // Muted, the VAD gets silence rather than nothing: the turn detector's clock runs on
      // frames, so dropping them mid-turn would leave that turn open until unmute instead
      // of letting the hangover close it. A fresh array each time, since the VAD may
      // transfer the buffer to its worker.
      capture = await captureWith(microphoneSource, (samples, at) => {
        vad.push(mutedBox.current ? new Float32Array(samples.length) : samples, at);
      });
    } catch (error) {
      // A refused microphone: the graph is up but nothing can reach it. Leave nothing
      // running behind the error.
      session.dispose();
      vad.terminate();
      judge.terminate();
      speech.dispose();
      await audio.close();
      throw error;
    }
    log?.(`listening on ${capture.deviceLabel}`);

    return new VoiceCall(options, audio, vad, judge, session, capture, mutedBox);
  }

  /** End the call. Idempotent: a second call does nothing. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.capture?.stop();
    this.session.dispose();
    this.vad.terminate();
    this.judge.terminate();
    this.options.speech.dispose();
    await this.audio.close();
  }
}
