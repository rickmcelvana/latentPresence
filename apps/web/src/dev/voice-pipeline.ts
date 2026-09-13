import {
  ConversationMachine,
  Reply,
  TurnDetector,
  VoiceSession,
  type PlaybackEvent,
  type PlaybackSink,
} from '@latentpresence/core';
import {
  asrModel,
  createAsrWorker,
  createKokoroWorker,
  createSmartTurnWorker,
  createVadWorker,
  kokoroModel,
  resample,
  sileroVadModel,
  smartTurnModel,
} from '@latentpresence/ml-web';
import type { ConversationEvent, ModelDescriptor, SpokenAudioChunk, SttResult, TTSProvider, TtsRequest } from '@latentpresence/protocol';
import {
  BrowserSileroVad,
  FakeLLMProvider,
  KokoroBrowserTTSProvider,
  MoonshineBrowserSTTProvider,
  SmartTurnJudge,
  createAudioOutput,
  microphoneSource,
  speculativeTranscription,
  startCapture,
  type AudioOutputHandle,
  type CaptureHandle,
  type CaptureSource,
} from '@latentpresence/providers';
import { analyseOutput, joinBlocks, type Mark, type OutputReport } from './output-check';

/**
 * The P1-T08 harness: the promoted pipeline end to end in a browser, with a scripted model.
 *
 * Microphone (or a simulated speaker) → Silero → `TurnDetector` + Smart Turn → Moonshine →
 * `FakeLLMProvider` → Kokoro → the AudioWorklet queue, with `VoiceSession` deciding what
 * counts and the two-stage barge-in in the middle. A fake model because a barge-in test
 * wants a long answer, the same every time, with no key.
 *
 * **The simulated speaker** is Kokoro in a second voice, played into the capture graph on
 * the audio clock — so turn detection, recognition and barge-in run on real speech in a
 * pane with no microphone and no person, and keep real time where page timers would not.
 *
 * Dev-only, and guarded out of production builds like the spikes it replaces.
 */

export type InputChoice = 'simulated' | 'microphone';

export const CHARACTER_VOICE = 'af_heart';
const USER_VOICE = 'am_michael';

export const ANSWER = [
  'The afternoon light came in low across the desk, and it caught the dust in the air.',
  'For a while nobody said anything, because there was nothing that needed saying.',
  'Then the kettle clicked off in the kitchen, and the moment was over.',
  'I remember thinking that I would like to keep that feeling for a little longer.',
].join(' ');
const QUESTION = 'What was the afternoon like?';
const INTERRUPTION = 'Sorry, can I stop you there for a second?';

/**
 * The three sentences `live/kokoro-dtype.ts` rendered on onnxruntime-node, with its fp32
 * durations. A browser rendering that matches them to the frame and reads back word for
 * word is a working voice; `q8` on WebGPU did neither, which is why it is refused.
 */
export const VOICE_CHECK_SENTENCES: readonly { readonly text: string; readonly nodeMs: number }[] = [
  { text: 'The afternoon light came in low across the desk.', nodeMs: 3400 },
  { text: 'She sells sixty-six shiny thistles; his sister just stopped asking.', nodeMs: 4525 },
  { text: 'Ohhh, I see, so you were waiting all along, were you?', nodeMs: 3400 },
];

/** Kokoro is fp32: every quantised precision is refused on WebGPU (P1-T08). */
export function downloads(): readonly ModelDescriptor[] {
  return [sileroVadModel(), smartTurnModel('gpu'), asrModel('moonshine-tiny', 'fp32'), kokoroModel('fp32')];
}

export interface TurnRow {
  readonly id: number;
  user: string | null;
  reason: 'model' | 'hangover' | null;
  /** The turn's last speech frame, on the performance clock. */
  readonly speechEndAt: number | null;
  probability: number | null;
  /** Smart Turn's own inference time for the answer nearest the turn end. */
  judgeMs: number | null;
  /** From the turn's last speech frame to the first answer frame at the ear. */
  speechEndToAudioMs: number | null;
  /** Synthesis of the answer's first sentence, request to last chunk. */
  firstSentenceSynthMs: number | null;
  reply: string | null;
  heard: string | null;
  status: 'waiting' | 'answering' | 'complete' | 'interrupted' | 'retracted' | 'abandoned' | 'failed';
}

export interface VoiceCheckRow {
  readonly text: string;
  readonly durationMs: number;
  readonly nodeMs: number;
  readonly synthMs: number;
  readonly peak: number;
  readonly transcript: string;
  readonly wordErrors: number;
  readonly words: number;
}

export interface Snapshot {
  readonly state: string;
  readonly rows: readonly TurnRow[];
  readonly log: readonly string[];
  readonly input: string;
  readonly outputLatencyMs: number;
  /**
   * Worst delay over the last ~5 s from a frame's capture time to its arrival on the main
   * thread, and to its Silero probability arriving back. Turn detection and barge-in run on
   * frame time, so a backlog here is latency every measurement downstream inherits.
   */
  readonly lagMs: { readonly capture: number; readonly vad: number };
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replaceAll(/[^a-z0-9' ]+/gu, ' ')
    .split(/\s+/u)
    .filter((word) => word !== '');
}

/** Word-level edit distance: substitutions, insertions and deletions against the reference. */
export function wordErrors(reference: string, hypothesis: string): number {
  const ref = words(reference);
  const hyp = words(hypothesis);
  let previous = Array.from({ length: hyp.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ref.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= hyp.length; j += 1) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost);
    }
    previous = current;
  }
  return previous[hyp.length] ?? 0;
}

async function collect(chunks: AsyncIterable<SpokenAudioChunk>): Promise<Float32Array> {
  const parts: Float32Array[] = [];
  for await (const chunk of chunks) if (chunk.samples.length > 0) parts.push(chunk.samples);
  return joinBlocks(parts);
}

async function transcribe(stt: MoonshineBrowserSTTProvider, samples16k: Float32Array): Promise<string> {
  // Moonshine only emits its end token with silence after the last word (docs/SURFACE.md).
  const padded = new Float32Array(samples16k.length + 4800 + 8000);
  padded.set(samples16k, 4800);
  async function* once() {
    yield { samples: padded, sampleRate: 16_000, startMs: 0 };
  }
  let text = '';
  for await (const result of stt.transcribe(once())) if (result.isFinal) text = result.text;
  return text;
}

/** Pass a synthesis through, and report how long it took from the first pull to the last chunk. */
async function* timedSynthesis(
  chunks: AsyncIterable<SpokenAudioChunk>,
  done: (elapsedMs: number) => void,
): AsyncIterable<SpokenAudioChunk> {
  const started = performance.now();
  for await (const chunk of chunks) yield chunk;
  done(performance.now() - started);
}

export class VoicePipeline {
  private readonly listeners = new Set<(snapshot: Snapshot) => void>();
  private readonly rows: TurnRow[] = [];
  private readonly logLines: string[] = [];
  private readonly marks: Mark[] = [];
  private readonly blocks: Float32Array[] = [];
  private recordStart: number | null = null;
  private userSpeech: { question: Float32Array; interruption: Float32Array } | null = null;
  private capture: CaptureHandle | null = null;
  private simulated: { context: AudioContext; input: AudioNode } | null = null;
  private lastJudgeMs: number | null = null;
  private lastTurnEnd: { reason: 'model' | 'hangover'; speechEndAt: number } | null = null;
  private lag = { capture: 0, vad: 0, windowStart: 0, reported: { capture: 0, vad: 0 } };
  private autoInterruptMs: number | null = null;
  private machineState = 'idle';
  private inputLabel = 'none';

  private readonly audio: AudioOutputHandle;
  private readonly tts: KokoroBrowserTTSProvider;
  private readonly stt: MoonshineBrowserSTTProvider;
  private readonly judge: SmartTurnJudge;
  private readonly vad: BrowserSileroVad;

  private constructor(
    audio: AudioOutputHandle,
    tts: KokoroBrowserTTSProvider,
    stt: MoonshineBrowserSTTProvider,
    judge: SmartTurnJudge,
    vad: BrowserSileroVad,
  ) {
    this.audio = audio;
    this.tts = tts;
    this.stt = stt;
    this.judge = judge;
    this.vad = vad;
  }

  /** Build everything and load every model. Call from a click: the audio context needs a gesture. */
  static async start(options: { bargeInMs: number; log: (line: string) => void }): Promise<VoicePipeline> {
    const t0 = performance.now();
    const audio = await createAudioOutput();
    const tts = new KokoroBrowserTTSProvider({ id: 'kokoro', createWorker: createKokoroWorker });
    const stt = new MoonshineBrowserSTTProvider({ id: 'moonshine', createWorker: createAsrWorker });
    let pipeline: VoicePipeline | null = null;
    const judge = new SmartTurnJudge({
      createWorker: createSmartTurnWorker,
      onMeasured: (m) => pipeline?.onJudge(m.inferenceMs, m.probability),
    });
    const vad = new BrowserSileroVad({ createWorker: createVadWorker });
    pipeline = new VoicePipeline(audio, tts, stt, judge, vad);
    pipeline.log(`output context ${audio.context.sampleRate} Hz, outputLatency ${Math.round((audio.context.outputLatency || 0) * 1000)} ms, baseLatency ${Math.round(audio.context.baseLatency * 1000)} ms`);
    options.log('loading Silero and Smart Turn');
    await Promise.all([vad.load(), judge.load()]);
    pipeline.log(`turn models ready in ${Math.round(performance.now() - t0)} ms`);
    const warm = performance.now();
    await collect(tts.synthesize({ text: 'Ready.', voiceId: CHARACTER_VOICE, speed: 1, hint: null }));
    pipeline.log(`Kokoro fp32 warm in ${Math.round(performance.now() - warm)} ms`);
    const warmStt = performance.now();
    await transcribe(stt, new Float32Array(8000));
    pipeline.log(`Moonshine warm in ${Math.round(performance.now() - warmStt)} ms`);
    pipeline.wire(options.bargeInMs);
    return pipeline;
  }

  subscribe(listener: (snapshot: Snapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  /** Feed the pipeline from the microphone, or from the simulated speaker. */
  async listen(input: InputChoice): Promise<void> {
    await this.capture?.stop();
    this.simulated = null;
    const source: CaptureSource =
      input === 'microphone'
        ? microphoneSource
        : async (context, node) => {
            // A constant zero keeps the capture worklet fed between utterances.
            const floor = context.createConstantSource();
            floor.offset.value = 0;
            floor.connect(node);
            floor.start();
            this.simulated = { context, input: node };
            return { label: 'simulated speaker (Kokoro am_michael)', stop: () => floor.stop() };
          };
    if (input === 'simulated' && this.userSpeech === null) {
      this.log('synthesising the simulated speaker');
      const speak = async (text: string) =>
        resample(await collect(this.tts.synthesize({ text, voiceId: USER_VOICE, speed: 1, hint: null })), 24_000, 16_000);
      this.userSpeech = { question: await speak(QUESTION), interruption: await speak(INTERRUPTION) };
    }
    this.capture = await startCapture(source, (samples, at) => {
      this.noteLag('capture', at);
      this.vad.push(samples, at);
    });
    this.inputLabel = this.capture.deviceLabel;
    this.log(`listening: ${this.inputLabel}`);
    this.emit();
  }

  /** The simulated speaker asks the question. */
  ask(): void {
    this.say('question', 0);
  }

  /** The simulated speaker talks over the answer. */
  interrupt(): void {
    this.say('interruption', 0);
  }

  /** Interrupt automatically this long after the character starts speaking; null to stop. */
  setAutoInterrupt(ms: number | null): void {
    this.autoInterruptMs = ms;
  }

  /** What the worklet rendered so far, checked for clicks at every event that could cause one. */
  outputReport(): OutputReport {
    return analyseOutput(joinBlocks(this.blocks), this.marks);
  }

  /**
   * Kokoro on WebGPU against node's renderings: durations, level, edges, and whether
   * Moonshine can read the words back — the failure a quantised graph shows on WebGPU is
   * speech-shaped audio with no words in it, which only a transcript catches.
   */
  async voiceCheck(): Promise<VoiceCheckRow[]> {
    const rows: VoiceCheckRow[] = [];
    for (const { text, nodeMs } of VOICE_CHECK_SENTENCES) {
      const started = performance.now();
      const samples = await collect(this.tts.synthesize({ text, voiceId: CHARACTER_VOICE, speed: 1, hint: null }));
      const synthMs = performance.now() - started;
      let peak = 0;
      for (const value of samples) peak = Math.max(peak, Math.abs(value));
      const transcript = await transcribe(this.stt, resample(samples, 24_000, 16_000));
      rows.push({
        text,
        durationMs: (samples.length / 24_000) * 1000,
        nodeMs,
        synthMs,
        peak,
        transcript,
        wordErrors: wordErrors(text, transcript),
        words: words(text).length,
      });
      this.log(`voice check: ${Math.round((samples.length / 24_000) * 1000)} ms in ${Math.round(synthMs)} ms — "${transcript}"`);
    }
    return rows;
  }

  async stop(): Promise<void> {
    await this.capture?.stop();
    this.capture = null;
    this.vad.terminate();
    this.judge.terminate();
    this.tts.terminate();
    await this.audio.close();
  }

  private wire(bargeInMs: number): void {
    const output = this.audio.output;
    const context = this.audio.context;
    const latency = (): number => context.outputLatency || 0;
    const markNow = (kind: Mark['kind']): void => {
      if (this.recordStart !== null) this.marks.push({ kind, frame: (context.currentTime - this.recordStart) * context.sampleRate });
    };

    output.record((samples, time) => {
      this.recordStart ??= time;
      this.blocks.push(samples);
    });
    output.subscribe((event: PlaybackEvent) => {
      if (this.recordStart === null) return;
      const time = event.at / 1000 - latency();
      this.marks.push({ kind: event.type === 'started' ? 'start' : 'end', frame: (time - this.recordStart) * context.sampleRate });
    });

    // Every call that could click is marked where it happened.
    const sink: PlaybackSink = {
      enqueue: (segment) => output.enqueue(segment),
      duck: () => {
        markNow('duck');
        output.duck();
      },
      unduck: () => {
        markNow('unduck');
        output.unduck();
      },
      fadeOut: (ms) => {
        markNow('fade');
        return output.fadeOut(ms);
      },
      position: () => output.position(),
      subscribe: (listener) => output.subscribe(listener),
    };
    const machine = new ConversationMachine({
      sessionId: 'harness',
      characterId: 'alice',
      fadeOutMs: 100,
      ports: { audioOut: sink },
    });

    const timedTts = this.timed(this.tts);
    // No per-token delay: a page timer is throttled to once a second in a hidden tab, and the
    // answer arriving at once changes nothing downstream — synthesis is sequential anyway.
    const llm = new FakeLLMProvider('scripted', {
      script: [
        ...ANSWER.split(/(?<= )/u).map((text) => ({ type: 'text-delta', text }) as const),
        { type: 'finish', reason: 'stop', usage: null },
      ],
    });

    const detector = new TurnDetector<Promise<SttResult | null>>({
      now: () => performance.now(),
      judge: this.judge,
      recognise: speculativeTranscription(this.stt),
    });
    // Before the session subscribes, so the row exists when its events reach the machine.
    detector.subscribe((event) => {
      if (event.type === 'turn-end') {
        this.lastTurnEnd = { reason: event.reason, speechEndAt: event.speechEndAt };
        this.log(`turn end (${event.reason}${event.probability === null ? '' : ` ${event.probability.toFixed(2)}`}) ${Math.round(event.at - event.speechEndAt)} ms after speech`);
      } else if (event.type === 'turn-resumed') {
        this.log(`turn resumed after a ${Math.round(event.pauseMs)} ms pause (ADR-25)`);
      } else if (event.type === 'late') {
        this.log(`late judge answer ${event.probability.toFixed(2)}`);
      }
    });

    output.subscribe((event) => {
      const row = this.rows.at(-1);
      if (event.type === 'started' && row !== undefined && row.speechEndToAudioMs === null && row.status === 'answering' && row.speechEndAt !== null) {
        const ctxToPerf = performance.now() - context.currentTime * 1000;
        row.speechEndToAudioMs = event.at + ctxToPerf - row.speechEndAt;
      }
    });

    machine.subscribe((event) => this.onEvent(event));
    const session = new VoiceSession({
      sessionId: 'harness',
      machine,
      detector,
      sink,
      bargeIn: { bargeInMs },
      transcribe: async (recognition) => (await recognition)?.text ?? null,
      respond: (text, replyOptions) =>
        new Reply(
          {
            modelId: 'scripted',
            messages: [{ role: 'user', content: text }],
            tools: [],
            temperature: null,
            maxOutputTokens: null,
          },
          { llm, tts: timedTts, sink, voiceId: CHARACTER_VOICE },
          replyOptions,
        ),
    });
    this.vad.onFrame((frame) => {
      this.noteLag('vad', frame.at);
      session.push(frame);
    });
    this.vad.onError((error) => this.log(`VAD error: ${error.message}`));
    machine.start();
  }

  private onEvent(event: ConversationEvent): void {
    const row = this.rows.at(-1);
    switch (event.type) {
      case 'state.changed':
        this.machineState = event.to;
        if (event.to === 'speaking' && this.autoInterruptMs !== null) this.say('interruption', this.autoInterruptMs / 1000);
        break;
      case 'user.turn.ended':
        this.rows.push({
          id: this.rows.length + 1,
          user: null,
          reason: this.lastTurnEnd?.reason ?? null,
          speechEndAt: this.lastTurnEnd?.speechEndAt ?? null,
          probability: event.probability,
          judgeMs: this.lastJudgeMs,
          speechEndToAudioMs: null,
          firstSentenceSynthMs: null,
          reply: null,
          heard: null,
          status: 'waiting',
        });
        break;
      case 'user.turn.resumed':
        if (row !== undefined) row.status = 'retracted';
        break;
      case 'user.transcript':
        if (row !== undefined) {
          row.user = event.text;
          row.status = 'answering';
        }
        break;
      case 'assistant.interrupted':
        if (row !== undefined) row.status = 'interrupted';
        this.log(`barge-in committed; heard: "${event.spokenPrefix}"`);
        break;
      case 'assistant.message':
        if (row !== undefined) {
          row.reply = event.entry.text;
          row.heard = event.entry.spokenPrefix;
          if (row.status === 'answering') row.status = 'complete';
        }
        break;
      case 'error':
        this.log(`${event.scope} error: ${event.message}`);
        if (row !== undefined && row.status !== 'complete') row.status = 'failed';
        break;
      default:
        break;
    }
    this.emit();
  }

  private noteLag(stage: 'capture' | 'vad', at: number): void {
    const now = performance.now();
    this.lag[stage] = Math.max(this.lag[stage], now - at);
    if (now - this.lag.windowStart > 5000) {
      this.lag.reported = { capture: Math.round(this.lag.capture), vad: Math.round(this.lag.vad) };
      if (this.lag.reported.vad > 100) this.log(`frame lag: capture ${this.lag.reported.capture} ms, Silero ${this.lag.reported.vad} ms`);
      this.lag = { capture: 0, vad: 0, windowStart: now, reported: this.lag.reported };
      this.emit();
    }
  }

  private onJudge(inferenceMs: number, probability: number): void {
    this.lastJudgeMs = inferenceMs;
    this.log(`Smart Turn ${probability.toFixed(2)} in ${Math.round(inferenceMs)} ms`);
  }

  /** Wrap the TTS provider to time each sentence, and credit the first to the current turn. */
  private timed(inner: TTSProvider): TTSProvider {
    return {
      id: inner.id,
      capabilities: () => inner.capabilities(),
      listVoices: () => inner.listVoices(),
      synthesize: (request: TtsRequest, options) =>
        timedSynthesis(inner.synthesize(request, options), (elapsed) => {
          const row = this.rows.at(-1);
          if (row !== undefined && row.firstSentenceSynthMs === null) row.firstSentenceSynthMs = elapsed;
        }),
    };
  }

  private say(which: 'question' | 'interruption', delaySeconds: number): void {
    const speech = this.userSpeech?.[which];
    const simulated = this.simulated;
    if (speech === undefined || simulated === null) {
      this.log('the simulated speaker is not listening');
      return;
    }
    const buffer = simulated.context.createBuffer(1, speech.length, 16_000);
    buffer.getChannelData(0).set(speech);
    const source = simulated.context.createBufferSource();
    source.buffer = buffer;
    source.connect(simulated.input);
    source.start(simulated.context.currentTime + delaySeconds);
    this.log(`simulated speaker: "${which === 'question' ? QUESTION : INTERRUPTION}"${delaySeconds > 0 ? ` in ${Math.round(delaySeconds * 1000)} ms` : ''}`);
  }

  private log(line: string): void {
    this.logLines.push(`${(performance.now() / 1000).toFixed(2)}  ${line}`);
    if (this.logLines.length > 200) this.logLines.shift();
    this.emit();
  }

  private snapshot(): Snapshot {
    return {
      state: this.machineState,
      rows: this.rows.map((row) => ({ ...row })),
      log: [...this.logLines],
      input: this.inputLabel,
      outputLatencyMs: Math.round((this.audio.context.outputLatency || 0) * 1000),
      lagMs: this.lag.reported,
    };
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}
