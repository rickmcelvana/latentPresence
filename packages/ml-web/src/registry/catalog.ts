import { ASR_MODELS, type AsrModelKey } from '../asr/messages';
import { FACE_MODEL } from '../face/messages';
import { kokoroModel } from '../kokoro/messages';
import { SER_MODELS, type SerModelKey } from '../ser/messages';
import { SILERO_VAD, SMART_TURN } from '../turn/messages';
import { FACE_SOURCE, KOKORO_MODEL_REPO, KOKORO_VOICES_REPO } from './wanted';
import { PINS } from './pins';

/**
 * The model registry (P9-T05, ADR-70): everything this app can download, for people to read.
 * RESEARCH.md's promise, "a model registry shows each model's licence". Every number comes from
 * the catalogs the consent screens read, and those from `pins.ts`, so the page cannot disagree
 * with what a consent screen says or with what a worker will accept.
 *
 * Its own subpath, because `pins.ts` is the only part of it a page that downloads needs.
 */
export interface RegistryEntry {
  readonly id: string;
  readonly name: string;
  readonly does: string;
  readonly licence: string;
  readonly sourceUrl: string;
  /** What it downloads, one number per choice of precision or build, smallest first. */
  readonly sizes: readonly number[];
  /** Keys of `PINS` this entry's files are listed under. */
  readonly sources: readonly string[];
}

const ascending = (sizes: readonly number[]): number[] => sizes.toSorted((a, b) => a - b);

function asrEntry(key: AsrModelKey, does: string): RegistryEntry {
  const spec = ASR_MODELS[key];
  return {
    id: key,
    name: spec.label,
    does,
    licence: spec.licence,
    sourceUrl: `https://huggingface.co/${spec.modelId}`,
    sizes: ascending(Object.values(spec.bytes)),
    sources: [spec.modelId],
  };
}

function serEntry(key: SerModelKey, does: string): RegistryEntry {
  const spec = SER_MODELS[key];
  return {
    id: `ser-${key}`,
    name: spec.label,
    does,
    licence: spec.licence,
    sourceUrl: `https://huggingface.co/${spec.repo}`,
    sizes: [spec.files.reduce((sum, file) => sum + file.bytes, 0)],
    sources: [spec.repo],
  };
}

const kokoro = kokoroModel('fp32');

export const REGISTRY: readonly RegistryEntry[] = [
  {
    id: 'kokoro',
    name: 'Kokoro 82M',
    does: 'Her voice, made on this computer. About 0.5 MB more for each voice used.',
    licence: kokoro.licence,
    sourceUrl: kokoro.sourceUrl,
    sizes: ascending([kokoroModel('q8').sizeBytes, kokoroModel('fp16').sizeBytes, kokoro.sizeBytes]),
    sources: [KOKORO_MODEL_REPO, KOKORO_VOICES_REPO],
  },
  asrEntry('moonshine-tiny', 'Hears you, on this computer. English.'),
  asrEntry('moonshine-base', 'Hears you, on this computer. English, more accurate.'),
  asrEntry('whisper-tiny-en', 'Hears you, on this computer. English, with word timings.'),
  asrEntry('whisper-base', 'Hears you, on this computer, in many languages.'),
  {
    id: 'silero',
    name: SILERO_VAD.label,
    does: 'Notices when someone is speaking.',
    licence: SILERO_VAD.licence,
    sourceUrl: `https://huggingface.co/${SILERO_VAD.repo}`,
    sizes: [SILERO_VAD.bytes],
    sources: [SILERO_VAD.repo],
  },
  {
    id: 'smart-turn',
    name: 'Smart Turn v3.2',
    does: 'Tells when you have finished your turn.',
    licence: SMART_TURN.gpu.licence,
    sourceUrl: `https://huggingface.co/${SMART_TURN.gpu.repo}`,
    sizes: ascending([SMART_TURN.cpu.bytes, SMART_TURN.gpu.bytes]),
    sources: [SMART_TURN.gpu.repo],
  },
  serEntry('distill', 'Hears how you sound. Optional.'),
  serEntry('base', 'Hears how you sound, more accurately. Optional.'),
  {
    id: 'face',
    name: 'MediaPipe Face Landmarker',
    does: 'Reads your expression from the camera. Optional, and no frame is kept.',
    licence: FACE_MODEL.licence,
    sourceUrl: FACE_MODEL.sourceUrl,
    sizes: [FACE_MODEL.sizeBytes],
    sources: [FACE_SOURCE],
  },
];

export interface RegistryFile {
  readonly source: string;
  readonly revision: string;
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

/** Every file a source may serve, for a person who wants to check for themselves. */
export function registryFiles(sources: readonly string[]): RegistryFile[] {
  return sources.flatMap((source) => {
    const pin = PINS[source];
    if (pin === undefined) return [];
    return Object.entries(pin.files).map(([path, file]) => ({ source, revision: pin.revision, path, ...file }));
  });
}
