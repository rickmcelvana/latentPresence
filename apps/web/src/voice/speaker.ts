import type { ChatVoice } from '@latentpresence/core';
import type { ModelConsent } from '@latentpresence/ml-web/consent';
import type { TTSProvider } from '@latentpresence/protocol';
import { createAudioOutput, type AudioOutputHandle } from '@latentpresence/providers';
import type { SettingsDeps } from '../settings/deps';
import type { Settings } from '../settings/settings';
import { WARM_TEXT, sinkOf, synthesizeAndDiscard } from './call';
import { buildTtsProvider, type Terminable } from './providers';

export { voiceModelsFor } from './models';

/**
 * Typed replies spoken aloud (P2-T08): the character's voice on `/chat` with no microphone.
 *
 * A call is a voice and an ear; this is the voice alone — the output graph and the Voice
 * slot from `/settings`, nothing else. `ChatSession.setVoice(speaker.voice)` does the rest:
 * a typed turn is then answered by the same `Reply` a spoken one is, so the machine reaches
 * `speaking`, the talk clip plays, and `CallStage` taps `output` for the mouth exactly as it
 * taps a call's.
 *
 * `/chat` imports this lazily, for the same reason as `VoicePanel`: a browser voice pulls
 * in ONNX Runtime and kokoro-js, and a person who only types and reads should fetch none
 * of it.
 */

export interface SpeakerOptions {
  readonly settings: Pick<Settings, 'tts'>;
  readonly deps: SettingsDeps;
  /** Must already cover `voiceModelsFor(settings)`, or the gated worker throws. */
  readonly consent: ModelConsent;
  /** Test seams. Production passes neither. */
  readonly createAudio?: () => Promise<AudioOutputHandle>;
  readonly buildTts?: (settings: Pick<Settings, 'tts'>, deps: SettingsDeps, consent: ModelConsent) => Promise<TTSProvider & Terminable>;
}

export class Speaker {
  /** For `ChatSession.setVoice`. */
  readonly voice: ChatVoice;
  /** For `CallStage`'s lip sync. */
  readonly output: AudioOutputHandle;
  private readonly tts: TTSProvider & Terminable;
  private stopped = false;

  private constructor(voice: ChatVoice, output: AudioOutputHandle, tts: TTSProvider & Terminable) {
    this.voice = voice;
    this.output = output;
    this.tts = tts;
  }

  /**
   * Build the graph and load the voice. **Call from a click**, as `VoiceCall.start`: an
   * `AudioContext` made without a gesture starts suspended and plays nothing. The voice is
   * warmed on one word, so the first answer does not pay Kokoro's load inside the wait.
   */
  static async start(options: SpeakerOptions): Promise<Speaker> {
    const { settings, deps, consent } = options;
    const audio = await (options.createAudio ?? createAudioOutput)();
    let tts: (TTSProvider & Terminable) | null = null;
    try {
      tts = await (options.buildTts ?? buildTtsProvider)(settings, deps, consent);
      await synthesizeAndDiscard(tts, WARM_TEXT, settings.tts.voiceId);
    } catch (error) {
      tts?.terminate?.();
      await audio.close();
      throw error;
    }
    const voice: ChatVoice = { tts, sink: sinkOf(audio), voiceId: settings.tts.voiceId, speed: settings.tts.speed };
    return new Speaker(voice, audio, tts);
  }

  /** Close the graph and stop a browser voice's worker. Idempotent. The caller takes the
   * voice off the session first (`setVoice(null)`), which stops an answer in flight. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.tts.terminate?.();
    await this.output.close();
  }
}
