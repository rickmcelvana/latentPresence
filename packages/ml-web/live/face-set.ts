/**
 * A labelled set of faces for P3-T06's heuristic, made on the local ComfyUI.
 *
 * Six people × seven expressions, and **each person is one seed**: the prompt changes only
 * in its expression words, so a person's neutral picture is a fair resting face for their
 * others — which is how `FaceAffectReader` works, against the face it settled on. The set
 * is generated, not collected, so nobody's face is in it and there is no licence to track.
 * `/dev/face` scores it in a real browser worker; the pictures stay in `live/out/faces`
 * (gitignored).
 *
 * Needs ComfyUI on 127.0.0.1:8188 with `flux1-schnell-fp8.safetensors`.
 *
 *   pnpm live:face-set
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const COMFY = process.env['COMFY_URL'] ?? 'http://127.0.0.1:8188';
const OUT = join(import.meta.dirname, 'out', 'faces');

const PEOPLE = [
  'a woman in her twenties with long black hair and East Asian features',
  'a man in his forties with a short beard and dark brown skin',
  'a woman in her sixties with grey hair and glasses',
  'a man in his twenties with curly red hair and freckles',
  'a woman in her thirties with dark curly hair and brown skin, South Asian features',
  'a man in his fifties, bald, with light olive skin',
];

/** The expression words, written as what the face does — a generator draws a label badly and a face well. */
const EXPRESSIONS: Readonly<Record<string, string>> = {
  neutral: 'a calm, relaxed neutral expression, mouth closed, looking straight at the camera',
  happy: 'smiling broadly with genuine happiness, cheeks raised, eyes crinkled',
  sad: 'looking sad and downcast, inner eyebrows raised, the corners of the mouth turned down',
  angry: 'looking angry, eyebrows drawn down and together, lips pressed tight, glaring',
  surprised: 'looking surprised, eyebrows raised high, eyes wide open, mouth open',
  disgusted: 'looking disgusted, nose wrinkled, upper lip raised',
  fearful: 'looking frightened, eyebrows raised and pulled together, eyes wide, mouth stretched',
};

function workflow(prompt: string, seed: number): Record<string, unknown> {
  return {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'flux1-schnell-fp8.safetensors' } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['1', 1] } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['1', 1] } },
    '4': { class_type: 'EmptyLatentImage', inputs: { width: 768, height: 768, batch_size: 1 } },
    '5': {
      class_type: 'KSampler',
      inputs: { model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0], seed, steps: 4, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1 },
    },
    '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    '7': { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'latentpresence-face' } },
  };
}

async function generate(prompt: string, seed: number): Promise<Uint8Array> {
  const queued = (await (await fetch(`${COMFY}/prompt`, { method: 'POST', body: JSON.stringify({ prompt: workflow(prompt, seed) }) })).json()) as { prompt_id: string };
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const history = (await (await fetch(`${COMFY}/history/${queued.prompt_id}`)).json()) as Record<string, { outputs: Record<string, { images?: { filename: string; subfolder: string; type: string }[] }> }>;
    const image = history[queued.prompt_id]?.outputs['7']?.images?.[0];
    if (image === undefined) continue;
    const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder, type: image.type });
    return new Uint8Array(await (await fetch(`${COMFY}/view?${query.toString()}`)).arrayBuffer());
  }
}

mkdirSync(OUT, { recursive: true });
const manifest: { file: string; person: number; label: string }[] = [];
for (const [person, who] of PEOPLE.entries()) {
  for (const [label, how] of Object.entries(EXPRESSIONS)) {
    const prompt = `A realistic webcam photo, head and shoulders, of ${who}, ${how}. Indoor lighting, plain wall behind, face centred and facing the camera.`;
    const file = `p${person}-${label}.png`;
    writeFileSync(join(OUT, file), await generate(prompt, 1000 + person));
    manifest.push({ file, person, label });
    console.log(file);
  }
}
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
