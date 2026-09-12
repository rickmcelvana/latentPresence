/**
 * The seams between the conversation machine and the world (P1-T01). Each is a plain
 * TypeScript interface declared in core; the browser and companion implement them in
 * later tasks. Nothing here touches a DOM or audio API — that is why these are ports
 * and not concrete classes.
 *
 * Wiring timeline:
 * - `AudioInPort`   — P1-T07 (VAD + turn detection) feeds speech events into the machine.
 * - `AudioOutPort`  — P1-T08 wires the real AudioWorklet playback queue and 100 ms fade
 *   in here; P1-T01's machine already uses `fadeOutMs` as its teardown duration.
 * - `LLMPort`       — P1-T02 provides the OpenAI-compatible LLM.
 * - `STTPort`/`TTSPort` — P1-T06 / P1-T05 provide recognition and synthesis.
 */

/** User-side input: the thing that observes the mic and reports turn boundaries. */
export interface AudioInPort {
  /** Begin listening; routes speech-start/stop/turn-end into the machine's dispatch. */
  start(): void;
  /** Stop the capture without ending the session. */
  stop(): void;
}

/** Assistant-side output: plays synthesized audio and exposes the barge-in fade. */
export interface AudioOutPort {
  /** Stop audio promptly (P1-T08 implements the real worklet fade with this budget). */
  fadeOut(ms: number): void;
}

/** LLM request seam; the OpenAI-compatible provider lands in P1-T02. */
export interface LLMPort {
  /** Ask the model to continue a user turn. */
  request(text: string): void;
}

/** Speech recognition seam; lands in P1-T06. */
export interface STTPort {
  transcribe(audio: unknown): void;
}

/** Speech synthesis seam; lands in P1-T05. */
export interface TTSPort {
  synthesize(sentence: string): void;
}

/** Everything the machine can reach beyond its own state and bus. All optional so the
 * machine works headless in tests and before a task has landed. */
export interface Ports {
  audioIn?: AudioInPort;
  audioOut?: AudioOutPort;
  llm?: LLMPort;
  stt?: STTPort;
  tts?: TTSPort;
}
