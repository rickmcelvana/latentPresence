# SURFACE — verified third-party facts

Append-only. Newest dated entry wins. Nothing goes in here from model memory: every entry is
checked against the vendor's docs or a live call, and says which. Rule in `CLAUDE.md`.

---

## zod 4.5.4 — 2026-09-08, verified by live call (`node` against the installed package)

Used by `packages/protocol`. Zod 4 moved several things that Zod 3 habits get wrong.

| Fact | Result |
|---|---|
| Top-level format helpers exist | `z.uuid()`, `z.email()`, `z.url()`, `z.int()`, `z.iso.date()`, `z.iso.datetime()` |
| Chained v3 forms still exist | `z.string().email()`, `z.string().datetime()`, `z.number().int()` — deprecated, do not use |
| `z.iso.datetime()` accepts | `2026-09-08T10:00:00Z` yes; `+02:00` only with `{ offset: true }`; bare local time no |
| `z.record(value)` with one argument | Accepted at runtime; always pass the key type: `z.record(z.string(), value)` |
| `z.record(enum, v)` | **Requires every enum member.** A subset fails to parse |
| `z.partialRecord(enum, v)` | Subset allowed, unknown keys rejected — this is what partial maps want |
| Unknown keys on `z.object` | Stripped, not rejected. `z.strictObject` rejects them |
| Recursion | `z.lazy(() => …)` works; annotate the const with `z.ZodType<T>` to break the type cycle |
| `z.custom<T>(guard)` | Runs the guard; use for in-process values like `Float32Array` |
| Errors | `ZodError`, `error.issues[0]` is `{ code, expected, path, message }`; `z.prettifyError`, `z.treeifyError` |
| `.readonly()` | Freezes the parsed output (`Object.isFrozen` true) |
| JSON Schema export | `z.toJSONSchema(schema)` exists — the path to MCP tool schemas in P5 |

## Browser voice stack — 2026-09-08, verified by installing the packages and querying the HF API

For P0-T04 (Spike A). Versions, model ids, licences and byte sizes below are read from the installed
packages and from `huggingface.co/api/models/...`, not recalled.

**transformers.js is pinned to v3, not the current v4.** `kokoro-js@1.2.1` depends on
`@huggingface/transformers@^3.5.1`. Taking v4.2.0 for speech recognition would put two major versions
of transformers.js in the bundle, each with its own ONNX Runtime. v3.8.1 supports Moonshine
(`MoonshineForConditionalGeneration`, the `automatic-speech-recognition` pipeline) and offers
`webgpu` and `wasm` devices, so one copy serves both ends of the pipeline.

**`@ricky0123/vad-web@0.0.30` is not used.** It depends on `onnxruntime-web@^1.17.0`, which resolves
to 1.29.0, while transformers 3.8.1 pins the exact dev build `1.22.0-dev.20250409-89f8206ba4`. Two
runtimes, ~91 MB of package each. Silero VAD runs directly instead, on an `onnxruntime-web` declared
at that same exact version so pnpm and Vite resolve one copy. **That pin is not arbitrary: it must
track whatever `@huggingface/transformers` depends on, and moving one without the other silently
doubles the runtime.**

`env.backends.onnx` from transformers is the ORT *Env* (configuration), not the namespace — it has
no `InferenceSession`, so it cannot be used to avoid the direct dependency.

`kokoro-js@1.2.1` was last published 2025-05-03. It is a thin wrapper (tokeniser, phonemiser, voice
table) over transformers.js, so it ageing is a maintenance note rather than a blocker.

### Models the spike downloads

| Model | Repo | Licence | File | Size |
|---|---|---|---|---|
| Silero VAD | `onnx-community/silero-vad` | MIT | `onnx/model.onnx` | 2.24 MB |
| Moonshine tiny (encoder) | `onnx-community/moonshine-tiny-ONNX` | MIT | `onnx/encoder_model_quantized.onnx` | 7.94 MB |
| Moonshine tiny (decoder) | `onnx-community/moonshine-tiny-ONNX` | MIT | `onnx/decoder_model_merged_quantized.onnx` | 20.24 MB |
| Kokoro 82M | `onnx-community/Kokoro-82M-v1.0-ONNX` | Apache-2.0 | `onnx/model_q8f16.onnx` | 86.03 MB |

About **116 MB** on first run at those quantisations. fp16 variants, which suit WebGPU better, cost
more: Kokoro fp16 is 163.23 MB and Moonshine fp16 is 15.52 + 76.25 MB. Whichever is chosen, ADR-09
means the consent screen shows these numbers before a byte moves.

## kokoro-js 1.2.1 `stream()` never terminates — 2026-09-08, verified by reading dist and by a live run

`KokoroTTS.stream(text)` given a **plain string** hangs: no audio, no completion, no
error. Read from `dist/kokoro.web.js`:

- `stream()` builds a `TextSplitterStream`, `push`es the text, and **never calls
  `close()`**.
- The splitter only emits a sentence when its terminator is followed by more buffer
  (`if (o === t) break;`). A sentence whose terminator is the last character stays
  buffered and is emitted only by the flush inside `close()`.
- Its async iterator is `for(;;) { if (sentences.length) yield …; else if (!closed) await
  new Promise(r => resolver = r); }` — so once the buffer is drained it waits forever for
  input that cannot arrive.

Observed exactly that on 2026-09-08: every utterance reached "asking for synthesis" and
nothing followed.

**Use the splitter directly**, which `stream()` accepts and which keeps per-sentence
streaming:

```ts
const sentences = new TextSplitterStream();
sentences.push(text);
sentences.close();
for await (const chunk of tts.stream(sentences, { voice })) { … }
```

`generate()` is the non-streaming alternative, but it returns only when the whole
utterance is synthesised, which would make "first audio" meaningless.

## Moonshine on WebGPU — 2026-09-08, observed, not yet isolated

On Rick's machine (Chrome, Arozzi Sfera Pro at 48 kHz resampled to 16 kHz):

- **q8 + webgpu**: loads, and returns the *same* string regardless of the audio —
  `"quartifies prconfirminé…"` with a repeating tail that grows with utterance length.
  Identical output for different input means the encoder result is not reaching the
  decoder; this is not the model guessing badly.
- **fp16 + webgpu**: fails to load, throwing a bare ONNX Runtime wasm exception pointer.

Capture was ruled out first: the buffer handed to the recogniser plays back as clean
speech, 31744 samples for 1984 ms (16 kHz exactly), RMS ~0.1–0.26, peak ~0.5–1.0, Silero
confidence 0.97–1.00.

Still to test: wasm, which is transformers.js's default backend for q8 and the
best-covered path, and fp32 on webgpu. Recorded here so the next person does not spend
the same evening on the microphone.

## Smart Turn v3 — 2026-09-08, verified against the HF API (for P0-T07)

`pipecat-ai/smart-turn-v3`, BSD-2-Clause. Checked ahead of the spike so it does not start
by discovering the model moved. There are three revisions and two builds each, and the
choice matters:

| File | Size |
|---|---|
| `smart-turn-v3.0.onnx` | 8.76 MB |
| `smart-turn-v3.1-cpu.onnx` / `-gpu.onnx` | 8.68 / 32.41 MB |
| `smart-turn-v3.2-cpu.onnx` / `-gpu.onnx` | 8.68 / 32.41 MB |

The cpu and gpu builds are different graphs, not the same graph at two precisions — the
gpu one is nearly four times the size. Spike A found that assuming a backend's default is
how you get fluent nonsense (ADR-20), so P0-T07 should try both rather than picking one,
and start from v3.2.

Untested here: whether either build runs under onnxruntime-web, which is the whole
question P0-T07 answers.

## Smart Turn v3 input surface — 2026-09-08, verified by reading the graphs and the reference code

The model card does not state the input format; it points at the GitHub repo. So both
`smart-turn-v3.2-cpu.onnx` and `-gpu.onnx` were downloaded and their protobuf graph
headers read directly, and `pipecat-ai/smart-turn`'s `inference.py` and `audio_utils.py`
were read at `main`. Both graphs agree:

| | Name | Type | Shape |
|---|---|---|---|
| Input | `input_features` | float32 | `[batch, 80, 800]` |
| Output | `logits` | float32 | `[batch, 1]` |

- **80 mel bins, 800 frames.** Not Whisper's usual 3000-frame 30 s window: the extractor is
  `WhisperFeatureExtractor(chunk_length=8)`, so `n_samples` is 128 000 and
  `nb_max_frames` is `128000 // 160` = 800. A summary of the model card claimed
  `(1, 128, 3000)`; the graph says otherwise, which is why the graph was read.
- **`logits` is a misnomer.** `inference.py` reads `outputs[0][0]` straight as a
  probability, and the graph does contain a `Sigmoid`. Treat the output as already
  activated — but assert it lies in `[0, 1]` rather than trusting the name either way.
- **cpu is int8, gpu is fp32.** The cpu graph's producer is `onnx.quantize`; the gpu
  graph's is `pytorch`. They are the same 8M-parameter model (Whisper tiny encoder plus a
  linear head) at two precisions after all, despite the file names. Exact bytes:
  8 679 182 and 32 411 198. Given Spike A, int8 on WebGPU is the combination to distrust.
- Opset 18, IR version 10.

### Preprocessing, which is where this goes wrong silently

`inference.py` does three things around the extractor that the extractor does not do:

1. `truncate_audio_to_last_n_seconds(audio, 8)` keeps the **last** 8 s, and when the audio
   is shorter it pads with zeros **at the beginning**. transformers.js pads at the *end*
   (`waveform.set(audio)` at offset 0), so the padding has to be done on our side and the
   extractor handed exactly 128 000 samples, or every short utterance is fed backwards
   relative to training.
2. `do_normalize=True` applies `zero_mean_unit_var_norm` — `(x - mean) / sqrt(var + 1e-7)`,
   population variance — to the waveform before the mel. It runs over the **whole padded
   128 000 samples**: `do_normalize` forces `return_attention_mask=True` in `pad()`, and
   with the array already at `max_length` the mask is all ones. **transformers.js's
   `WhisperFeatureExtractor` has no `do_normalize` at all**, so this must be applied by us
   or the features are on the wrong scale.
3. Everything else — Hann window, `n_fft` 400, `hop_length` 160, slaney mel filters over
   0–8000 Hz, `log10`, then `(max(x, x.max() - 8) + 4) / 4` — matches
   `@huggingface/transformers` 3.8.1's `WhisperFeatureExtractor` exactly, once it is
   constructed with `{ feature_size: 80, n_fft: 400, hop_length: 160, sampling_rate: 16000,
   chunk_length: 8, n_samples: 128000, nb_max_frames: 800 }`. Python computes 801 STFT
   frames and drops the last; the JS caps at `nb_max_frames`. Same 800 frames.

`WhisperFeatureExtractor` is exported from the `@huggingface/transformers` top level and
its constructor takes a plain config object — no `from_pretrained`, so no hub fetch and
nothing to declare on the consent screen for the extractor itself. There are no deep
imports (one `exports` entry), so importing it pulls the whole barrel including ONNX
Runtime; that is worker-only and the build guard already covers it.

The clamp in step 3 gives a free runtime check: for any input that is not perfectly flat,
`max - min` over the feature block is **exactly 2.0**. A mel that is wrong in shape or
scale generally will not satisfy that.

### Under onnxruntime-web, 2026-09-08, verified by running all four combinations

The open question above — whether either build runs — is answered. Six deterministic
synthetic clips, medians of a warm pass, Chromium 152, NVIDIA Blackwell. Detail and
caveats in `docs/spikes/D-smart-turn.md`.

| Build | Backend | Load (warm) | Log-mel | Inference |
|---|---|---|---|---|
| cpu (int8) | wasm | 528 ms | 31 ms | 153 ms |
| cpu (int8) | webgpu | — | — | **will not load** |
| gpu (fp32) | wasm | 744 ms | 32 ms | 222 ms |
| gpu (fp32) | webgpu | 996 ms | 38 ms | **8 ms** |

- int8 on WebGPU fails at load with `[DequantizeLinear] ... In the case of dequantizing
  int32 there is no zero point` — loudly, unlike Moonshine q8, which returned nonsense.
- fp32 gives **identical probabilities on wasm and WebGPU**, so the GPU path is correct
  and not just fast.
- int8 and fp32 **disagree on the same audio**, by enough to cross the 0.5 threshold in
  both directions. The builds are not interchangeable and a threshold does not carry
  between them.
- The 800-frame Whisper log-mel costs 31–38 ms in JavaScript. Not the bottleneck, and no
  reason to move it to the companion.


## Feedback API — 2026-09-08, verified by reading the running service's source

`tools/feedback-api` in the latent-mastering repo, which Caddy proxies at
`latentpresence.com/api/feedback`. Contract only; no code was taken from that repo.

`POST /api/feedback`, `Content-Type: application/json`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `kind` | string | yes | `bug`, `suggestion` or `other`. Anything else is silently coerced to `other` |
| `message` | string | yes | Empty after trim gives `400` |
| `_hp` | string | **yes** | Honeypot. Must be present, even as `""` — it is a bare `String` in the deserialiser, so omitting it fails the request before any handler runs. Non-empty is accepted-and-dropped with `204` |
| `source` | string | no | Whitelisted: `mastering`, `mixing`, `presence`. Anything else stores as `unknown`. **`presence` is live** (Rick, 2026-09-07); the emails say "Latent Presence" |
| `email` | string or null | no | Follow-up only |
| `user_agent` | string or null | no | |
| `screen_width` / `screen_height` | int or null | no | The reference form sends `window.innerWidth`/`innerHeight`, so these are viewport, not screen |

Responses: `204` success (and for a tripped honeypot), `400` empty message, `429` rate limited
(5 per IP per hour), `500` insert failed. A missing `_hp` is a deserialiser rejection, not a `400`.

`GET /api/health` returns `ok` without touching the database. It exists to tell a missing Caddy
route (404) from a dead service (502), which is how the latentbeats.com move actually failed.

## GitHub Actions used by `.github/workflows/ci.yml` — 2026-09-08, verified against the GitHub API

`actions/checkout@v7` (v7.0.1), `actions/setup-node@v7` (v7.0.0), `pnpm/action-setup@v6` (v6.1.0),
`Swatinem/rust-cache@v2` (v2.9.2), `dtolnay/rust-toolchain@stable` (branch exists; that repo tags by
toolchain name, not by release). First green run on `main`: 2026-09-08.

## pnpm 11.24.0 — 2026-09-08, verified by live call

`minimumReleaseAge` is on by default with roughly a 24-hour cutoff. A dependency published inside the
window fails the install unless it is listed in `minimumReleaseAgeExclude` in `pnpm-workspace.yaml`.
We keep the protection and pin ranges slightly behind the newest release instead of excluding.

## Toolchain versions the gate is green against — 2026-09-08

TypeScript 7.0.2 (native port), Vite 8.2.2, Vitest 5.0.0, oxlint 1.81.0, React 19.2.8, Node 22.22.3,
rustc 1.97.1, axum 0.8.9, tokio 1.53.1.

Notes that cost time once:
- A project referenced by another `tsconfig` may not set `noEmit` (TS6310). Referenced projects are
  `composite` + `emitDeclarationOnly` into `.tsbuild/`; runtime resolution goes to `src/` through
  each package's `exports`, so there is no build step for packages.
- oxlint's `react` plugin has no `jsx-uses-react` rule; only `react/react-in-jsx-scope` needs turning
  off for the React 19 automatic runtime.

## Avatar stack for P0-T05 — 2026-09-09, verified against the npm registry and the files themselves

| Package | Version | Licence | Note |
|---|---|---|---|
| `three` | **0.185.1** | MIT | Not 0.186.0: published 2026-09-08 and inside pnpm 11's release-age window. three-vrm is developed against `^0.180.0`, r3f needs `>=0.156` |
| `@pixiv/three-vrm` | 3.5.5 | MIT | Peer `three: >=0.137`. Pulls six sibling packages (`-core`, `-materials-mtoon`, `-materials-hdr-emissive-multiplier`, `-materials-v0compat`, `-node-constraint`, `-springbone`) all pinned to the same version |
| `@pixiv/three-vrm-animation` | 3.5.5 | MIT | The VRMA loader plugin |
| `@react-three/fiber` | 9.7.0 | MIT | Peer **`react: >=19 <19.3`** |
| `wawa-lipsync` | 0.0.2 | MIT | See below. No `repository` field, no dependencies, 125 KB unpacked |

`@react-three/drei` was not taken. The spike needs a camera and a loop, not a helper library.

### The r3f peer range is a live constraint, not a formality

`>=19 <19.3` against this repo's React `^19.2.8`. It resolves today and **a bump to React 19.3
breaks it**, which is a thing to notice when it happens rather than discover in CI.

### wawa-lipsync does not speak VRM

Its `VISEMES` enum is the Oculus/ARKit set — fifteen values, `viseme_sil`, `viseme_PP`, `viseme_FF`,
`viseme_TH`, `viseme_DD`, `viseme_kk`, `viseme_CH`, `viseme_SS`, `viseme_nn`, `viseme_RR`,
`viseme_aa`, `viseme_E`, `viseme_I`, `viseme_O`, `viseme_U`. VRM 1.0 has **five** mouth expressions
plus silence, which is also what `VisemeSchema` in `packages/protocol` says.

So a mapping layer is not optional, and nine of the fifteen have no VRM equivalent at all. Read out
of the published `dist/index.d.ts`, not from the README:

- `Lipsync` is constructed with `{ fftSize, historySize }`, connected with
  `connectAudio(el: HTMLMediaElement)` or `connectMicrophone()`, and stepped with `processAudio()`
  once per frame. After each step, `lipsync.viseme` is the current winner and `lipsync.features`
  carries `{ bands, deltaBands, volume, centroid }`.
- Per-viseme scores exist (`computeVisemeScores`) but are a pure function taking features as
  arguments rather than a property, so the ergonomic path is the winning viseme plus `volume` as
  its weight.
- It is version 0.0.2, last published 2025-11-07, with no repository link in the manifest. Small
  enough to read end to end, which is the reason to accept it for a spike and the reason to keep
  the mapping in our own code where it can be tested.

### The sample avatar: redistributable, but not Creative Commons

`VRM1_Constraint_Twist_Sample.vrm` from `pixiv/three-vrm` (10 776 032 bytes). The repository is MIT
and carries no separate asset licence, and the file's own embedded `VRMC_vrm.meta` — read out of the
glTF JSON chunk — says:

```
authors: ["pixiv Inc."]          copyrightInformation: (c) 2022 pixiv Inc.
licenseUrl: https://vrm.dev/licenses/1.0/
avatarPermission: everyone       commercialUsage: corporation
allowRedistribution: true        modification: allowModificationRedistribution
creditNotation: unnecessary
```

**That is the VRM Public License 1.0, not CC0 or CC-BY**, which is what ADR-11 asks of assets. It is
redistributable on its own terms, so the honest handling is to fetch it at run time behind the same
consent screen the model spikes use — size, licence and source on screen — rather than commit it and
quietly acquire an asset that does not match the repo's licence policy. It is a placeholder until
Alice lands in P7-T02 either way.

It is VRM **1.0** (`specVersion: "1.0"`), 3 meshes, 171 nodes, 19 images, and uses
`VRMC_springBone`, `VRMC_materials_mtoon` and `VRMC_node_constraint`. Its expression presets are
`aa, ee, ih, oh, ou` plus `blink, blinkLeft, blinkRight`, `lookUp/Down/Left/Right` and
`neutral, happy, angry, sad, relaxed, surprised` — **exactly the five visemes `VisemeSchema` defines**,
and enough emotion presets for the P3 affect work.

### The sample animation is a loader test, not an idle

`test.vrma` from the same repo, 11 548 bytes: `VRMC_vrm_animation` spec 1.0, 51 human bones mapped,
`expressions` and `lookAt` blocks present — but its single animation has **three channels**. It
proves the VRMA loading path and nothing about how an idle looks. A real idle clip is an asset
decision for P2/P7; there is no CC0 VRMA in that repository to take.
