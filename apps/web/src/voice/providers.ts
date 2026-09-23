import type { ModelConsent } from '@latentpresence/ml-web/consent';
import {
  browserGpu,
  createGatedAsrWorker,
  createGatedKokoroWorker,
  kokoroSupport,
  type GpuLike,
} from '@latentpresence/ml-web';
import type { STTProvider, TTSProvider } from '@latentpresence/protocol';
import {
  KokoroBrowserTTSProvider,
  MoonshineBrowserSTTProvider,
  OpenAICompatibleSTTProvider,
  OpenAICompatibleTTSProvider,
  WhisperBrowserSTTProvider,
} from '@latentpresence/providers';
import type { HttpFetch } from '@latentpresence/providers/web';
import type { SettingsDeps } from '../settings/deps';
import { STT_KEY_REF, TTS_KEY_REF, type Settings } from '../settings/settings';

/**
 * Voice and Hearing choices, actually built (P1-T15).
 *
 * Until this task `/settings`'s Voice and Hearing sections were a form with nothing behind
 * it: an option could be chosen, saved and never read by anything, because `/dev/voice`
 * built Kokoro and Moonshine directly. This is the one place both slots become providers,
 * so the settings a person picks are the providers a call runs on.
 *
 * **Every browser provider goes through its `createGated*Worker`** (P1-T13). That is what
 * makes "nothing downloads without the consent screen" structural rather than a habit: a
 * call that skipped the screen fails in `requireConsent` before a worker exists to fetch
 * anything. The consent a caller passes must therefore cover `browserModelsFor(settings)`,
 * which is what `VoicePanel` shows on screen before it calls this.
 *
 * Keys come from the vault by their own refs, exactly as `/settings` saved them, and are
 * read at build time rather than on every request: a call is a short-lived object, and a
 * key changed mid-call is a reload, not a re-read.
 */

export interface SpeechProviders {
  readonly tts: TTSProvider;
  readonly stt: STTProvider;
  /** Stop the browser workers this built. A server provider holds nothing to stop. */
  dispose(): void;
}

/**
 * A browser TTS or STT provider, which owns a worker that outlives one call.
 *
 * `TTSProvider` and `STTProvider` — the protocol the rest of the pipeline is written
 * against — have no `terminate`: the queue, the session and `Reply` never stop a provider,
 * because a provider that can be restarted is a provider whose next synthesis silently
 * reloads 325 MB. The two browser providers do have one, and a call that ended has to use
 * it or the worker thread stays alive for the life of the page.
 */
export interface Terminable {
  terminate?: () => void;
}

function disposeOf(providers: readonly (TTSProvider | STTProvider)[]): () => void {
  return () => {
    for (const provider of providers) (provider as Terminable).terminate?.();
  };
}

/** `OpenAICompatibleSTTProvider` is typed against the global `fetch`, which is wider than
 * the `HttpFetch` every other caller in this app is given. Bridge the two rather than
 * widening `SettingsDeps`: stringifying a `Request` would produce "[object Request]", so
 * the URL case is kept. */
function asGlobalFetch(fetchFn: HttpFetch): typeof globalThis.fetch {
  return (input, init) => fetchFn(input instanceof Request ? input.url : String(input), init);
}

/**
 * A browser with no usable WebGPU has no call at all, and it should be told so in a
 * sentence rather than by ONNX Runtime.
 *
 * **This is `kokoroSupport`, which until now nothing called.** P1-T05 wrote it — three
 * distinct blockers, with Spike E's and Spike A's evidence in it — for "the settings UI
 * steers on it", and no UI ever did. The failure it prevents is a real one: every browser
 * model here defaults to WebGPU, and `q8`/`int8` are refused on wasm for good reasons
 * (ADR-20, Spike D), so a person on a browser without WebGPU gets a worker that dies with
 * an onnxruntime message no user can act on.
 *
 * It is checked whichever Voice and Hearing sources are chosen, because **the turn models
 * are always browser ones**: Smart Turn's `gpu` build is what `VoiceCall` constructs, and
 * Spike D's int8 `cpu` build — the no-GPU fallback it measured — is not wired up. That is
 * the honest state of it, and the message says what will work rather than what will not.
 */
async function requireWebGpu(gpu: GpuLike | null | undefined): Promise<void> {
  const support = await kokoroSupport(gpu === undefined ? browserGpu() : gpu);
  if (support.supported) return;
  throw new Error(
    `Voice needs WebGPU and this browser has none: ${support.detail}. Chrome or Edge with hardware acceleration will work.`,
  );
}

/**
 * The Voice slot alone (P2-T08), for typed replies spoken aloud: no microphone, so no
 * hearing and no turn models. **WebGPU is required only for a browser voice** — a server
 * voice speaks in any browser, which a full call cannot, because its turn models cannot.
 */
export async function buildTtsProvider(
  settings: Pick<Settings, 'tts'>,
  deps: SettingsDeps,
  consent: ModelConsent,
  /** Test seam: the real one is `navigator.gpu`. */
  gpu?: GpuLike | null,
): Promise<TTSProvider & Terminable> {
  const { tts } = settings;
  if (tts.kind === 'kokoro-browser') {
    await requireWebGpu(gpu);
    return new KokoroBrowserTTSProvider({
      id: 'kokoro-browser',
      // `fp32` and nothing else: every quantised Kokoro build is refused on WebGPU
      // (P1-T08 measured q8 returning speech-shaped audio with no words in it), and this
      // provider defaults to WebGPU because wasm synthesis is 3779 ms against 245 ms.
      createWorker: () => createGatedKokoroWorker(consent, 'fp32'),
    });
  }
  const apiKey = await deps.vault.loadKey(TTS_KEY_REF);
  return new OpenAICompatibleTTSProvider({
    id: 'tts-server',
    baseUrl: tts.baseUrl,
    model: tts.model,
    fetch: deps.fetch,
    ...(apiKey === null ? {} : { apiKey }),
  });
}

export async function buildSpeechProviders(
  settings: Pick<Settings, 'tts' | 'stt'>,
  deps: SettingsDeps,
  consent: ModelConsent,
  /** Test seam: the real one is `navigator.gpu`. */
  gpu?: GpuLike | null,
): Promise<SpeechProviders> {
  await requireWebGpu(gpu);
  const { stt } = settings;
  const builtTts = await buildTtsProvider(settings, deps, consent, gpu);

  let builtStt: STTProvider;
  if (stt.kind === 'moonshine-browser') {
    builtStt = new MoonshineBrowserSTTProvider({
      id: 'moonshine-browser',
      model: stt.model,
      createWorker: () => createGatedAsrWorker(consent, stt.model, 'fp32'),
    });
  } else if (stt.kind === 'whisper-browser') {
    builtStt = new WhisperBrowserSTTProvider({
      id: 'whisper-browser',
      model: stt.model,
      createWorker: () => createGatedAsrWorker(consent, stt.model, 'fp32'),
    });
  } else {
    const apiKey = await deps.vault.loadKey(STT_KEY_REF);
    builtStt = new OpenAICompatibleSTTProvider({
      id: 'stt-server',
      baseUrl: stt.baseUrl,
      model: stt.model,
      language: stt.language,
      fetch: asGlobalFetch(deps.fetch),
      ...(apiKey === null ? {} : { apiKey }),
    });
  }

  // Only the browser pair has a worker to stop; `disposeOf` asks and does nothing
  // otherwise, so this stays correct if a server adapter grows one later.
  return { tts: builtTts, stt: builtStt, dispose: disposeOf([builtTts, builtStt]) };
}
