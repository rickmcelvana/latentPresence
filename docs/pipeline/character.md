# Character pipeline — images to a VRM 1.0 avatar

How a latentPresence character is made, from three images to a validated VRM. Written for
Rick to follow without asking; any question asked gets folded back in here (P7-T01's
done-when). Alice is the worked example throughout. Verified on the dev PC on 2026-10-14.

**What you get:** `out/<name>.vrm` (desktop tier, ~40 MB) and `out/<name>.web.vrm` (web tier,
3–8 MB): VRM 1.0, 54 humanoid bones, 70 expressions (ARKit 52 face shapes and Meta visemes among them;
all 13 VRM presets mapped), blink, look-at. Alice: web 4.09 MB, all validators pass.

**How it works, in one paragraph:** never auto-rig. The appearance (clothes, body shape) comes
from a generated mesh; the rig, the hands, the head with its face shapes, and the hair come from
MPFB2 (MakeHuman, CC0), fitted to the generated mesh and to a close-up photo of the face. The
tools live in **`G:\_dev\image-to-vrm`** (Rick's repo, private on GitHub); its
`docs/ENVIRONMENT.md` §19–22 has the measurements behind every step here.

## 0. One-time setup (already done on the dev PC)

| Piece | Version / file | Where | Licence |
|---|---|---|---|
| Blender | 5.2.2 LTS | `C:\Program Files\Blender Foundation\Blender 5.2\` | GPL (tool only) |
| VRM add-on | 4.7.1 | Blender extensions | MIT |
| MPFB2 + asset packs | `makehuman_system_assets_cc0`, `faceunits01`, `visemes02` | `%APPDATA%\Blender Foundation\Blender\5.2\extensions\.user\blender_org\mpfb\data` | CC0 (per-asset headers) |
| ComfyUI | 0.40.0 | `G:\Comfy-Desktop\ComfyUI-Installs\comfyUI\ComfyUI` | GPL (tool only) |
| comfy-cli | 1.16.0 | `%APPDATA%\Python\Python314\Scripts\comfy.exe` | — |
| Z-Image Turbo | `z_image_turbo_int8_convrot.safetensors` + `qwen_3_4b_fp8_mixed.safetensors` + `ae.safetensors` | ComfyUI `models/` | Apache-2.0 |
| FLUX.2 Klein **4B** | `flux-2-klein-base-4b-fp8.safetensors` (3.81 GB) + `full_encoder_small_decoder.safetensors` | ComfyUI `models/` | Apache-2.0 |
| TRELLIS.2 | `trellis_2_int8_convrot.safetensors` + its VAEs | ComfyUI `models/` | MIT |
| MediaPipe face | `mediapipe_face_fp32.safetensors` | `G:\Comfy-Desktop\ComfyUI-Shared\models\detection` | Apache-2.0 |
| Validators | `npm install` once in `image-to-vrm\tools\validate` | — | — |

**Never use FLUX.2 Klein 9B for a character that ships.** It is installed, it works, and its
licence is the FLUX Non-Commercial License (§4(a): nothing it produces for "commercial or
production purposes"). Klein 4B does the same job under Apache-2.0.

Start ComfyUI the same way every time, so its log is kept and the right install runs (there are
two on this PC; comfy-cli's saved default is the other one):

```powershell
comfy --workspace "G:\Comfy-Desktop\ComfyUI-Installs\comfyUI\ComfyUI" launch --background
```

(Close ComfyUI Desktop first; both want port 8188.)

## 1. The three images

| # | Image | Model | Why |
|---|---|---|---|
| 1 | front portrait, head and shoulders, 1024² | Z-Image Turbo | the face: shape, skin, freckles, eye colour, hair colour |
| 2 | (optional) the same portrait with a changed hairstyle | Klein 4B image edit, one reference | only when the hair in #1 is not the hair the model will have |
| 3 | full-body T-pose, plain grey background, 1024² | Klein 4B image edit, two references: the portrait + `image-to-vrm\out\pose_tpose_1024.png` (a stick figure) | the body and clothes; the stick figure makes the arms horizontal (without it they droop ~20°) |

**The easy way:** in a Claude Code session with ComfyUI running, ask for them; Claude drives
ComfyUI through comfy-mcp and shows each one for approval.

**By hand, in the ComfyUI browser UI (`http://127.0.0.1:8188`):**

1. *Portrait.* Templates → **Z-Image-Turbo Int8: Text to Image**. Prompt (Alice's; keep the
   framing words, change the person):
   > Natural photograph, head and shoulders portrait of a woman in her late twenties, facing the
   > camera straight on, relaxed friendly expression with a slight closed-mouth smile, auburn hair
   > tied back in a low messy bun with a few loose strands, light freckles across nose and cheeks,
   > green eyes, natural brows, no makeup look, oatmeal crewneck knit sweater. Soft even studio
   > light, plain light grey seamless background, real skin texture, sharp focus, 85mm lens

   1024 × 1024, 8 steps, seed 2001. **Avoid "3D render" or "character" in the prompt**: they give
   a cartoon face, and the face texture is painted from this photo.
2. *Hairstyle edit.* Templates → **Flux.2 [Klein] 4B: Image Edit**. The template has two
   sub-graphs: use the **single-image** one (the other is bypassed by default). Load image =
   portrait #1. In the sub-graph, set the CLIP loader to `qwen_3_4b_fp8_mixed.safetensors` (the
   template's `qwen_3_4b.safetensors` is not installed and is not needed). Prompt:
   > Change only her hairstyle: her auburn hair is now pulled back smoothly into a neat low
   > ponytail at the nape of her neck, the ponytail hanging behind her, a few fine loose strands
   > at the temples. Keep exactly the same face, freckles, skin, eyes, expression, oatmeal sweater,
   > camera angle, framing, lighting and plain light grey background.

   Seed 5001, 20 steps, CFG 5 (template defaults).
3. *T-pose.* Same template, the **two-image** sub-graph: un-bypass it (select, Ctrl+B) and bypass
   the single-image one. Image 1 = the portrait (#2 if you made one), image 2 =
   `pose_tpose_1024.png` (copy it into ComfyUI's `input` folder first). CLIP as above. Prompt:
   > Full body photograph of the same woman from image 1, same face, same freckles, same auburn
   > hair pulled back into a low ponytail, same oatmeal crewneck knit sweater, now with slim
   > straight dark grey trousers and plain white sneakers. She stands exactly in the T-pose shown
   > by the skeleton in image 2: both arms extended horizontally out to the sides at shoulder
   > height, palms facing down, fingers together, legs straight and slightly apart, facing the
   > camera, symmetrical. Entire body visible head to toe, plain flat light grey seamless
   > background, even soft studio light, natural photograph, sharp focus. Do not draw the skeleton.

   Seed 5002.

**What makes a good T-pose:** arms straight out and level; hands open and separate from the
body; feet apart; nothing touching the edges; plain background; **a crew neck or other high
neckline** (it hides the neck seam); **short or tied-back hair** (the model's hair is an MPFB
asset, not the photo's); no bags, scarves, hoods, long open coats or beards (a beard broke the
head fit on an earlier character).

Alice's approved images are in `docs/pipeline/alice/` (`1-portrait.png`,
`2-portrait-ponytail.png`, `3-tpose.png`), with `concept-sheet.jpg`.

## 2. Build the VRM — one command, ~5 minutes

From `G:\_dev\image-to-vrm`, with ComfyUI running:

```powershell
python src\pipeline\image_to_vrm.py alice --gender 0 --image <T-pose png> --face-image <portrait png> --hair ponytail01
```

- `--gender 0` female, `1` male (picks the MPFB base body).
- `--face-image`: the portrait the face is painted and shaped from. Use the one whose hair is
  closest to the model's (Alice: `2-portrait-ponytail.png`).
- `--hair`: one of MPFB's CC0 hair meshes — `ponytail01`, `bob01`, `bob02`, `short01` to
  `short04`, `braid01`, `long01`, `afro01`. It replaces the generated hair and is tinted to the
  portrait's hair colour.
- A stage failing names its stage and log. Fix, then resume: `--from <stage>` (stages: image,
  landmarks, mesh, base, fit, shape, rebuild, skin, head, face, renders, vrm, web, validate).
  `--from head` takes about a minute.

## 3. Look at it — the validators cannot tell you it is the right character

A VRM can pass every check with the face on the chin (it happened). Look:

1. **In three-vrm** (the real colours; Blender's renders wash skin out):

   ```powershell
   cd tools\validate
   $env:SHOT_NECK = "1"; node shot.mjs ..\..\out\alice\look ..\..\out\alice.web.vrm
   ```

   Open `out\alice\look_alice.web_call.png` (the video-call framing), `_face.png`, `_neck.png`,
   `_body.png`. Or interactively: run the `vrm-viewer` preview from `image-to-vrm`'s
   `.claude/launch.json` and open
   `http://localhost:8765/tools/viewer/index.html?vrm=/out/alice.web.vrm`.
2. **Posed and talking** (Blender): `out\alice\posed_stress_0.png` (arms down, head turned) and
   `out\alice\expr.png` (blink, visemes, smile, frown).

**Good:** the face reads as the portrait (freckles, eye colour); the hairline is clean; the
sweater is one smooth surface; the neck runs into the collar with no gap; the posed render bends
cleanly at shoulders, elbows and knees.

**Known, accepted on Alice (2026-10-14):** small grey slivers at the back corners of the collar
(seen over the shoulders in the T-pose only); the sweater texture is soft (a 2048 bake for the
whole body, 1024 in the web tier); the T-pose shoulder line is flat (rest pose).

**Re-run instead of accepting:** a face that is not the portrait's, a hairline with blocks, flakes
or cracks in the clothes, anything floating, skin through clothes. Say what you see in a Claude
session; `image-to-vrm` has a fix history for most of these (ENVIRONMENT §19–22).

## 4. Validate

The last stage runs them; `validate: PASS` is required:

- `vrm_check.py` (structure: bones, expressions, materials),
- Khronos `gltf-validator` (errors 0; one `MESH_PRIMITIVE_GENERATED_TANGENT_SPACE` warning is
  expected),
- headless three-vrm (loads, 13/13 presets, blink both sides, gaze ±20°),
- **face match**: the rendered face against the portrait, as % of the eye distance. Informative,
  not pass/fail: Alice 2.56 %; above ~4 % look hard at the face.

## 5. Licence chain (read from the sources 2026-10-14; `docs/SURFACE.md`)

| Link | Licence |
|---|---|
| Z-Image Turbo (portrait) | Apache-2.0 |
| FLUX.2 Klein 4B (edit, T-pose) | Apache-2.0 |
| TRELLIS.2 (mesh) | MIT |
| MPFB2 base mesh, skins, hair, eyes, teeth, ARKit and viseme targets | CC0 |
| MediaPipe face landmarker weights (used, not shipped) | Apache-2.0 |
| Blender, VRM add-on, ComfyUI | tools; their licences do not reach the output |

Every link permits commercial use and redistribution, so the VRM can ship with the app under a
licence Rick chooses (P7-T02 decides it, and the VRM's own `meta` fields).

## 6. Into latentPresence (P7-T02, ADR-59)

Bodies are a library: built-in ones download through the consent screen with their exact bytes
and licence, and anyone can add their own `.vrm`, kept in their browser. Alice's **default body
stays the placeholder** (pixiv's sample — Rick's choice, ADR-18 amended); the generated Alice is a
built-in entry, "Alice, generated".

1. **Check it:** `/dev/avatar` → **Or load a .vrm from this computer** (or, once the stage is up,
   **Load a .vrm from this computer**) → `out\<name>.web.vrm`. The line under the stage names the
   body and says what it cannot show; every slider and preset on the page then drives it.
2. **Wear it:** in `/chat`, **Body** → **Add a .vrm…**. It is checked, kept in this browser, and worn
   at once, while you talk. A file the call cannot drive is refused with the reason.
3. **Make it a built-in body** (for everyone, not just this browser): a Claude session copies it to
   `assets/bodies/` (LFS) with its `meta` named and a `manifest.json` entry (bytes, sha256, licence,
   validation), commits it alone, then adds an entry to `BUILT_IN_BODIES` with its download URL
   pinned to that commit (`apps/web/src/call/character-asset.ts`, as `ALICE_GENERATED`).
