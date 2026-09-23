/**
 * `pnpm clips:build` — turns R-12's picks from Quaternius's Universal Animation Library into
 * the `.vrma` files the renderer loads, and writes `assets/clips/manifest.json` (P2-T03).
 *
 * The pack itself is not in the repo (`assets/clips/source/` is gitignored: it is Rick's
 * download, and 7 MB of mesh we do not use). The clips it produces are CC0 and are
 * committed, so the app and CI never need the pack — only rebuilding does.
 *
 * No Blender: the pack's rest pose is already VRM's T-pose facing +Z, so a clip is the
 * source's own tree and rotations relabelled (`src/clips/vrma.ts`). `checkTPose` refuses a
 * source for which that stops being true.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UAL_TO_VRM, buildVrma, checkTPose, parseGlb } from '../src/clips/vrma';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const PACK = 'Universal Animation Library[Standard]';
// The file without root motion: she stays on her mark (R-12).
const SOURCE = join(repo, 'assets/clips/source', PACK, 'Unreal-Godot/UAL1_Standard.glb');
const OUT = join(repo, 'assets/clips');

const CLIPS = [
  // R-15: the pack's idle clenches both fists; half-way back to the open rest is a relaxed hand.
  { id: 'idle', source: 'Idle_Loop', use: 'idle, listening, thinking, interrupted', relaxFingers: 0.6 },
  { id: 'talk', source: 'Idle_Talking_Loop', use: 'speaking' },
] as const;

const source = parseGlb(new Uint8Array(readFileSync(SOURCE)));
const problems = checkTPose(source.json, UAL_TO_VRM);
if (problems.length > 0) {
  throw new Error(`${SOURCE} is not in VRM's rest pose, so its clips would retarget wrongly:\n- ${problems.join('\n- ')}`);
}

mkdirSync(OUT, { recursive: true });
const entries = CLIPS.map((clip) => {
  const bytes = buildVrma(source, clip.source, {
    boneMap: UAL_TO_VRM,
    generator: `latentPresence build-clips (${clip.source})`,
    ...('relaxFingers' in clip ? { relaxFingers: clip.relaxFingers } : {}),
  });
  const file = `${clip.id}.vrma`;
  writeFileSync(join(OUT, file), bytes);
  console.log(`${file.padEnd(10)} ${bytes.byteLength.toLocaleString('en')} bytes  ← ${clip.source}`);
  return {
    id: clip.id,
    file,
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    use: clip.use,
    ...('relaxFingers' in clip ? { relaxFingers: clip.relaxFingers } : {}),
    source: { pack: 'Quaternius Universal Animation Library (Standard)', file: 'Unreal-Godot/UAL1_Standard.glb', animation: clip.source },
    licence: 'CC0-1.0',
    author: 'Quaternius',
    url: 'https://quaternius.itch.io/universal-animation-library',
  };
});

writeFileSync(
  join(OUT, 'manifest.json'),
  `${JSON.stringify({ note: 'Built by `pnpm clips:build` from the gitignored pack in source/. Do not edit by hand.', clips: entries }, null, 2)}\n`,
);
console.log(`manifest.json  ${entries.length} clips`);
