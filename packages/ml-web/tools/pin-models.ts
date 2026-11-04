import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  BODY_FILE,
  BODY_SOURCE,
  FACE_FILE,
  FACE_SOURCE,
  IDLE_CLIP_FILE,
  KOKORO_CONFIG_FILES,
  KOKORO_GRAPHS,
  KOKORO_MODEL_REPO,
  KOKORO_VOICES_REPO,
  KOKORO_VOICE_FILES,
  THEO_BODY_FILE,
  THEO_BODY_SOURCE,
  asrFiles,
  type AsrDtypeKey,
} from '../src/registry/wanted';

/**
 * Writes or checks `src/registry/pins.ts` (P9-T05, ADR-70).
 *
 *   pnpm pins:write   read every file below from its host and write the table
 *   pnpm pins:check   read them again and fail if a host no longer serves what is pinned
 *
 * **Moving a pin is a decision made here, by editing a commit below.** If the bytes change, what
 * a person agreed to has changed: give that model a new consent id in its catalog too (ADR-09).
 *
 * Hugging Face's tree API gives a Git LFS file's SHA-256, so a 373 MB graph need not be
 * downloaded to pin it; anything else is downloaded and hashed. `pins:check` runs weekly in
 * `audit.yml`: a repository deleted upstream should reach us before a tester.
 */

const ALL_ASR: readonly AsrDtypeKey[] = ['fp32', 'fp16', 'q8', 'q4', 'q4f16'];
// The Whisper repositories have no `_q4f16` pair.
const NO_Q4F16: readonly AsrDtypeKey[] = ['fp32', 'fp16', 'q8', 'q4'];
const asrSet = (dtypes: readonly AsrDtypeKey[]): string[] => [...new Set(dtypes.flatMap((dtype) => asrFiles(dtype)))];

interface HubSource {
  readonly kind: 'hub';
  readonly key: string;
  readonly revision: string;
  readonly files: readonly string[];
}

interface UrlSource {
  readonly kind: 'url';
  readonly key: string;
  readonly revision: string;
  readonly base: string;
  readonly files: readonly string[];
}

const SOURCES: readonly (HubSource | UrlSource)[] = [
  { kind: 'hub', key: KOKORO_MODEL_REPO, revision: 'dd4401a9add81ac692d20e240d22ec9dda82cc29', files: [...KOKORO_CONFIG_FILES, ...Object.values(KOKORO_GRAPHS)] },
  { kind: 'hub', key: KOKORO_VOICES_REPO, revision: '1939ad2a8e416c0acfeecc08a694d14ef25f2231', files: KOKORO_VOICE_FILES },
  { kind: 'hub', key: 'onnx-community/moonshine-tiny-ONNX', revision: 'a6da1241cd305dcd64eab1edbd615f2bb9aabb95', files: asrSet(ALL_ASR) },
  { kind: 'hub', key: 'onnx-community/moonshine-base-ONNX', revision: 'b1e9b6aae3c3c7298f10c3798393fdf38e8fbbad', files: asrSet(ALL_ASR) },
  { kind: 'hub', key: 'onnx-community/whisper-base_timestamped', revision: '608c49e61301901684bc36cac8f74b95ff6b5a8e', files: asrSet(NO_Q4F16) },
  { kind: 'hub', key: 'onnx-community/whisper-tiny.en_timestamped', revision: 'aeaa13760958b03fac5062f457d317d3319c3168', files: asrSet(NO_Q4F16) },
  { kind: 'hub', key: 'onnx-community/silero-vad', revision: 'e71cae966052b992a7eca6b17738916ce0eca4ec', files: ['onnx/model.onnx'] },
  { kind: 'hub', key: 'pipecat-ai/smart-turn-v3', revision: 'f766f81d3cfdf7737ac64aad813d91bbfd56bf93', files: ['smart-turn-v3.2-gpu.onnx', 'smart-turn-v3.2-cpu.onnx'] },
  { kind: 'hub', key: 'pankotaro/emotion2vec-plus-base-onnx', revision: '334d4376993c381f059cc36d2c6ed05cbfec5ca1', files: ['emotion2vec_plus_base.onnx', 'emotion2vec_head.json'] },
  { kind: 'hub', key: 'thomashallock/emotion2vec-web-distill', revision: '566a831be26e64f7e641241c26154793b7dd1428', files: ['distill-student-v4.fused.onnx'] },
  // The commit `dev` pointed at on 2026-11-03; the same bytes as `dev`, measured.
  {
    kind: 'url',
    key: BODY_SOURCE,
    revision: '3caf7a21ee68f0d5dfa363ab3d577450bbf60136',
    base: 'https://raw.githubusercontent.com/pixiv/three-vrm/3caf7a21ee68f0d5dfa363ab3d577450bbf60136/',
    files: [BODY_FILE, IDLE_CLIP_FILE],
  },
  // In this repository through LFS, so `raw.githubusercontent.com` would serve the pointer. The commit
  // that added it; a new version of him is a new file, a new commit and a new consent id (ADR-59).
  {
    kind: 'url',
    key: THEO_BODY_SOURCE,
    revision: '5b08aeef2ececa036d91b3915a713a29f829a0a0',
    base: 'https://media.githubusercontent.com/media/rickmcelvana/latentPresence/5b08aeef2ececa036d91b3915a713a29f829a0a0/',
    files: [THEO_BODY_FILE],
  },
  // Google's bucket has no commits: the version in the path is what can be named, and the hash holds it.
  {
    kind: 'url',
    key: FACE_SOURCE,
    revision: 'float16/1',
    base: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/',
    files: [FACE_FILE],
  },
];

interface Measured {
  readonly bytes: number;
  readonly sha256: string;
}

async function hashed(url: string): Promise<Measured> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

interface TreeEntry {
  readonly type: string;
  readonly path: string;
  readonly size: number;
  readonly lfs?: { readonly oid: string; readonly size: number };
}

async function measureHub(source: HubSource): Promise<Record<string, Measured>> {
  const listing = await fetch(`https://huggingface.co/api/models/${source.key}/tree/${source.revision}?recursive=true`);
  if (!listing.ok) throw new Error(`${source.key}@${source.revision}: HTTP ${listing.status}`);
  const tree = (await listing.json()) as readonly TreeEntry[];
  const out: Record<string, Measured> = {};
  for (const file of source.files) {
    const entry = tree.find((candidate) => candidate.type === 'file' && candidate.path === file);
    if (entry === undefined) throw new Error(`${source.key}@${source.revision} has no ${file}`);
    out[file] = entry.lfs !== undefined ? { bytes: entry.lfs.size, sha256: entry.lfs.oid } : await hashed(`https://huggingface.co/${source.key}/resolve/${source.revision}/${file}`);
  }
  return out;
}

async function measureUrl(source: UrlSource): Promise<Record<string, Measured>> {
  const out: Record<string, Measured> = {};
  for (const file of source.files) out[file] = await hashed(source.base + file);
  return out;
}

function render(measured: readonly { readonly source: HubSource | UrlSource; readonly files: Record<string, Measured> }[]): string {
  const blocks = measured.map(({ source, files }) => {
    const base = source.kind === 'hub' ? `https://huggingface.co/${source.key}/resolve/${source.revision}/` : source.base;
    const rows = Object.entries(files)
      .map(([path, file]) => `      '${path}': { bytes: ${file.bytes}, sha256: '${file.sha256}' },`)
      .join('\n');
    return `  '${source.key}': {\n    revision: '${source.revision}',\n    base: '${base}',\n    files: {\n${rows}\n    },\n  },`;
  });
  return [
    '// Generated by `pnpm pins:write` (packages/ml-web/tools/pin-models.ts). Do not edit by hand.',
    '',
    'export interface PinnedFile {',
    '  readonly bytes: number;',
    '  readonly sha256: string;',
    '}',
    '',
    'export interface PinnedSource {',
    '  /** The commit, or for a host with none, the version its path names. */',
    '  readonly revision: string;',
    '  /** An address that cannot move: `base + path` is the download. */',
    '  readonly base: string;',
    '  readonly files: Readonly<Record<string, PinnedFile>>;',
    '}',
    '',
    'export const PINS: Readonly<Record<string, PinnedSource>> = {',
    ...blocks,
    '};',
    '',
  ].join('\n');
}

const target = fileURLToPath(new URL('../src/registry/pins.ts', import.meta.url));
const measured = [];
for (const source of SOURCES) {
  measured.push({ source, files: source.kind === 'hub' ? await measureHub(source) : await measureUrl(source) });
  console.log(`read ${source.key}@${source.revision} (${source.files.length} files)`);
}
const table = render(measured);

if (process.argv.includes('--write')) {
  writeFileSync(target, table);
  console.log(`wrote ${target}`);
} else if (readFileSync(target, 'utf8').replaceAll('\r\n', '\n') !== table) {
  console.error('A host no longer serves what pins.ts records; run `pnpm pins:write` and read the diff.');
  process.exitCode = 1;
} else {
  console.log('Every pin still holds.');
}
