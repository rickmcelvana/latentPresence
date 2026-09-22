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

## pnpm 12.3.4 — 2026-09-09, verified by live call on the Fedora box

Was 11.24.0 (2026-09-08). **pnpm 12 manages its own version**: running a global pnpm 12 in a repo
pinned to 11 rewrites `packageManager` to `pnpm@12.3.4+sha512.…` and prepends a
`packageManagerDependencies` document to `pnpm-lock.yaml` carrying the `@pnpm/exe.*` binaries for
every platform. It is not a stray edit to revert — it comes back on the next install. The bump was
taken deliberately on 2026-09-09 rather than fought.

CI needs no change: `pnpm/action-setup@v6` runs with no `version` input and reads `packageManager`
out of `package.json`, so it follows the pin wherever it goes. **A second machine with a global
pnpm 11 will not**, so Rick's Windows box needs pnpm 12 before its next install.

`minimumReleaseAge` is on by default with roughly a 24-hour cutoff. A dependency published inside the
window fails the install unless it is listed in `minimumReleaseAgeExclude` in `pnpm-workspace.yaml`.
We keep the protection and pin ranges slightly behind the newest release instead of excluding. That
was verified on 11.24.0 and is **not** re-verified here.

## Toolchain versions the gate is green against — 2026-09-08, extended 2026-09-09

TypeScript 7.0.2 (native port), Vite 8.2.2, Vitest 5.0.0, oxlint 1.81.0, React 19.2.8, Node 22.22.3,
rustc 1.97.1, axum 0.8.9, tokio 1.53.1.

**Rick's Fedora 44 box, 2026-09-09:** Node 22.23.2, pnpm 12.3.4, **rustc 1.98.0** (Fedora's system
package, `1.98.0-1.fc44` — no rustup on that machine). Gate green there, 173 TypeScript and 17 Rust.

**rustc 1.98 broke the gate on its own.** Clippy 1.98 added `chunks_exact_to_as_chunks`, and
`-D warnings` makes any new lint an error, so `dtolnay/rust-toolchain@stable` turned main red on a
docs-only commit on both runners. The repo pins no toolchain and that stays a deliberate choice
(2026-09-09): the fixes are cheap and tend to be real simplifications. Expect this again on the next
stable.

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

## MariaDB vector, and the dev servers — 2026-09-09, verified by live call and against the docs

**The dev database moved to `192.168.40.101` the same day, and that one works.** Both are
recorded: the first host is where the round-trip figure that stresses the budget came from.

### `192.168.40.101` — MariaDB 11.8.8, and everything P0-T06 needs

Probed with the credentials in `.env`, running the shape the task actually calls for
rather than reading the version and inferring:

| | |
|---|---|
| `SELECT VERSION()` | **`11.8.8-MariaDB`** |
| `VEC_DISTANCE_COSINE`, `VEC_FromText`, `VEC_ToText` | all present and correct |
| `CREATE TABLE … VECTOR(768) NOT NULL, VECTOR INDEX (embedding) M=8 DISTANCE=cosine` | **accepted** |
| Insert via `VEC_FromText`, top-k by `VEC_DISTANCE_COSINE … ORDER BY … LIMIT` | correct ordering, distance 0 for the identical vector |
| `EXPLAIN` on that query | **`key: embedding`, `key_len: 3074`, `type: index`** — the vector index is used, not scanned |
| Grants | `ALL PRIVILEGES ON latentpresence.*` |
| RTT, thirty `SELECT 1`s | **min 0.27, p50 0.43, p95 0.80, max 1.02 ms** |

`SHOW CREATE TABLE` echoes the index back as
``VECTOR KEY `embedding` (`embedding`) `M`=8 `DISTANCE`=cosine``, on `ENGINE=InnoDB`,
`utf8mb4_uca1400_ai_ci`.

Server defaults worth knowing before the benchmark:

```
mhnsw_default_distance = euclidean      mhnsw_default_m = 6
mhnsw_ef_search        = 20             mhnsw_max_cache_size = 16777216   (16 MB)
```

`key_len` 3074 confirms the storage: **768 float32 is 3072 bytes a row**, so 100k rows is
about **307 MB of raw vectors against a 16 MB index cache**. That ratio is the thing the
100k case is really testing, and `mhnsw_max_cache_size` is the knob to report against.
`mhnsw_ef_search` (20) trades recall for speed at query time and belongs in the write-up
beside any latency figure, because a fast number at a low `ef_search` is a fast number for
a worse answer.

**Measured, later the same day: that ratio was the whole story.** Rick raised
`mhnsw_max_cache_size` to 2 GiB and `innodb_buffer_pool_size` to 4 GiB (16 GB box) and
restarted. Nothing else changed, and the same benchmark binary against the same 10,000 rows
went from a **7.52 ms** top-8 median to **1.51 ms** — a fivefold difference bought with a
setting, not with code. Both readings are honest; they measure different servers.

Two things follow for anyone reading a vector benchmark, ours included. The 16 MB default
is not a tuning preference, it is a cliff: below the working-set size the index cache
thrashes and the latency you measure is disk, not search. And a vector latency quoted
without `mhnsw_max_cache_size`, `innodb_buffer_pool_size` and `mhnsw_ef_search` beside it
is not a number anybody can reproduce.

`mhnsw_max_cache_size` is **`GLOBAL`-only** — `SET GLOBAL` needs `SUPER`, which a
database-scoped application user does not have. It is an operator's setting, so it belongs
in deployment documentation rather than in anything the product does at runtime.

**`mhnsw_ef_search`, by contrast, is `SESSION`-settable** — `SET SESSION mhnsw_ef_search =
40` succeeds as the ordinary application user (verified by live call, 2026-09-09). So
recall-versus-latency is a dial the product can turn per connection at runtime, while the
cache size is not.

**To get exact nearest neighbours instead of approximate ones, add `+ 0` to the ordering
expression.** `ORDER BY VEC_DISTANCE_COSINE(embedding, ?) LIMIT 8` plans as `type=index
key=embedding`; `ORDER BY VEC_DISTANCE_COSINE(embedding, ?) + 0 LIMIT 8` plans as
`type=ALL` with no key and returns the true top-k by full scan. Verified by `EXPLAIN` on
both forms against the same table. Useful for measuring recall, and a trap in the other
direction: an arithmetic expression wrapped around the distance silently costs the index.
At 100k rows the exact form took **247 ms** against the index form's single-digit
milliseconds.

Two other forms that look like they should defeat the index **do not** — a derived table
(`SELECT id FROM (SELECT id, VEC_DISTANCE_COSINE(…) AS d FROM t) x ORDER BY d`) and
`LIMIT 8 OFFSET 0` both still plan as `type=index key=embedding`.

### `10.0.0.1` over the tunnel — too old, but it gave the number that matters

| | |
|---|---|
| `SELECT VERSION()` | **`10.11.18-MariaDB-0+deb12u1`** (Debian 12) |
| `VEC_DISTANCE_COSINE`, `VEC_DISTANCE_EUCLIDEAN`, `VEC_FromText`, `VEC_ToText` | `ER_SP_DOES_NOT_EXIST` |
| RTT, thirty `SELECT 1`s | **min 37.76, p50 39.78, p95 40.49, max 41.63 ms** |

**The `VECTOR` type arrived in MariaDB 11.7.1**, so 10.11 has none of it — not the type,
not the index, not the functions.

### Two networks, two answers, and the second one is the design constraint

- **LAN (`192.168.40.101`): 0.43 ms.** The 100 ms per-turn retrieval budget is not
  meaningfully spent on the network at all.
- **Tunnel (`10.0.0.1`): 39.8 ms.** One statement fits inside 100 ms with room; two do
  not, and a lookup followed by a follow-up read has spent 80 ms before the server has
  done any work.

So the budget holds locally and is tight remotely, and that is a P4 design constraint
independent of which host the spike finally runs on: **retrieval wants to be one
statement**, and a remote deployment wants the companion near the database rather than
near the browser. Measure and report both; a LAN figure alone would say the network is
free, which is true in exactly one deployment.

### How a VECTOR column crosses the wire — 2026-09-09, verified by protocol probe

Whether sqlx can read a `VECTOR` column at all decides how P0-T06 is written, and the
answer people give in forum threads is "not yet, cast it to text". **That is wrong for
MariaDB's implementation**, and the protocol says so:

| | |
|---|---|
| Column type code for `VECTOR(4)` | **253** — `MYSQL_TYPE_VAR_STRING`, with the binary flag |
| Payload for `[1,2,3,4]` | `0000803f 00000040 00004040 00008040` |
| Interpretation | **little-endian `f32`, 4 bytes per dimension, no length prefix** |

There is no new wire type. A `VECTOR` arrives looking exactly like a `VARBINARY`, so a
driver that has never heard of vectors reads it as bytes and is correct — **sqlx needs no
custom `Type` impl and no `::text` cast**; `Vec<u8>` on the way out, `&[u8]` on the way in.

**Binding raw binary straight into a `VECTOR` column works.** A 16-byte little-endian f32
buffer sent as a prepared-statement parameter inserted cleanly and read back through
`VEC_ToText` as `[9,8,7,6]`. So the text path is optional, and for this project it is the
wrong one: 768 dimensions is **3072 bytes as binary against roughly 7–8 KB as a JSON
array**, plus server-side parsing on every insert. The benchmark should use binary and
report the difference if it measures both.

This also explains the `key_len` of 3074 seen on the index: 3072 bytes of vector plus a
two-byte length prefix.

### The syntax, from the MariaDB docs

```sql
CREATE TABLE embeddings (
        doc_id BIGINT UNSIGNED PRIMARY KEY,
        embedding VECTOR(1536) NOT NULL,
        VECTOR INDEX (embedding) M=8 DISTANCE=cosine
);
```

- The indexed vector column **must be `NOT NULL`**, and a table may have **only one**
  vector index.
- `M` is 3–200: larger is more accurate, slower, and hungrier for memory.
- `DISTANCE` is `cosine` or `euclidean` and **defaults to `euclidean`**.
- `VEC_FromText()` parses a JSON array string into the binary type; `VEC_ToText()` reverses
  it. Distance functions are `VEC_DISTANCE`, `VEC_DISTANCE_COSINE`, `VEC_DISTANCE_EUCLIDEAN`.

**The trap worth writing down:** a query whose distance function differs from the one the
index was built with **falls back to a full table scan**. It does not error and it does not
warn — it returns the right rows slowly. A benchmark that measured that while believing it
was measuring an index would produce a confident, wrong number about whether the retrieval
budget holds, which is precisely the failure Spike A's q8 path was. P0-T06 must declare
`DISTANCE=cosine` on the index, query with `VEC_DISTANCE_COSINE`, and **prove the index is
used with `EXPLAIN`** rather than inferring it from the timing.

## Tauri 2, for P0-T08 Spike E — 2026-09-09, verified against the registries and the Tauri docs

| Package | Version | Source |
|---|---|---|
| `@tauri-apps/cli` | **2.11.4** | npm registry, live call |
| `@tauri-apps/api` | **2.11.1** | npm registry, live call |
| `tauri` (crate) | **2.11.5** | crates.io API, live call |
| `wry` (the webview binding) | **0.57.0** | crates.io API, live call |

### Correction to the `wry` row, and two crates it missed — 2026-09-11

**`wry` 0.57.0 is what crates.io publishes. It is not what you get.** `tauri` 2.11.5
resolves **`wry` 0.55.1**, two minor versions back, by way of `tauri-runtime-wry` 2.11.4 and
`tauri-runtime` 2.11.3. Read from both lockfiles — the Linux one committed in 3988587 and a
Windows build on 2026-09-11 — so this is Tauri's pin, not a platform difference. The webview
binding is chosen by Tauri rather than by us, which makes "latest on crates.io" the wrong
question to have asked of that row.

The rest of the tree, same two sources: `tao` 0.35.3, `tray-icon` 0.24.2, `muda` 0.19.3,
`tauri-plugin-log` 2.9.1, `tauri-plugin-notification` **2.4.0**, and on Windows
`webview2-com` 0.38.2 and `tauri-winrt-notification` 0.7.3, against `notify-rust` 4.18.0 on
Linux.

### `tauri-plugin-notification` polyfills `window.Notification`, and the ACL still applies — 2026-09-11

With the plugin registered, a page containing **no Tauri code at all** that calls plain
`Notification.requestPermission()` is routed to the plugin's IPC command. Against a
capability file granting only `core:default`, it comes back as a rejected promise reading:

```
notification.request_permission not allowed. Permissions associated with this command:
notification:allow-request-permission, notification:default
```

That is Tauri's ACL, not a webview limitation — the web API **is** wired up, and the error
names the permission that fixes it. `notification:default` grants the whole set
(`allow-request-permission`, `allow-notify`, `allow-is-permission-granted` and thirteen
more; read from `gen/schemas/acl-manifests.json` on 2026-09-11).

**The trap is the diagnosis, not the fix.** From inside the page this is indistinguishable
from a webview that lacks the Notification API, and it was briefly written up here as
exactly that — inferred from Microsoft documenting that WebView2 raises notifications to the
host, and from `https://v2.tauri.app/plugin/notification/` documenting only the plugin and
never mentioning `window.Notification`. Both readings were accurate; the conclusion drawn
from their silence was not, and one click disproved it. A surface is verified against docs
**or a live call**, and where they disagree the live call wins. An inference from an absence
was never either — which is the same trap this file already warns about for WebGPU on
WebKitGTK, two sections down.

For P8-T01, narrowly: **write a capability file against the plugins registered, not against
the code the page appears to contain.**

### Linux system prerequisites, quoted from the Tauri docs

`https://tauri.app/start/prerequisites/`, read 2026-09-09. The webview package is
**`4.1` on every distribution** — not `4.0`, which is the soup2 generation Tauri moved off
in 2.0.0-alpha.3.

```
Debian/Ubuntu  libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev
               libssl-dev libayatana-appindicator3-dev librsvg2-dev
Arch           webkit2gtk-4.1 base-devel curl wget file openssl appmenu-gtk-module
               libappindicator-gtk3 librsvg xdotool
Fedora         webkit2gtk4.1-devel openssl-devel curl wget file
               libappindicator-gtk3-devel librsvg2-devel libxdo-devel
```

Rust is required (rustup); Node LTS is required only because the frontend is JavaScript.
Neither has a pinned minimum in that page.

**Verified on Fedora 44, 2026-09-09.** The listed packages were all present and the shell
built and ran: `webkit2gtk4.1-devel` 2.52.5, `gtk3-devel` 3.24.52, `libappindicator-gtk3-devel`,
`librsvg2-devel`, `openssl-devel`, `libxdo-devel`, `curl`, `file`. **`wget` was absent and
nothing needed it** — Tauri lists it only to fetch things. rustup is *not* required either:
Fedora's system `rustc` 1.98.0 built the shell fine.

### WebGPU on WebKitGTK — **measured 2026-09-09: it is not there**

Superseding the "not established" note below, which was written before the live call.
Inside the Tauri webview on Fedora 44 with **webkit2gtk4.1 2.52.5**, `navigator.gpu` is
**undefined**. In the same library, `strings` finds the WebGPU IPC plumbing
(`WebKit::WebGPU::… convertToBacking(GPU…)`), the preference name `WebGPUEnabled`, and the
literal message `WebGPU platform is unsupported.` — but **zero** occurrences of the JS
interface names `GPUAdapter`, `GPUDevice`, `GPUCanvasContext`, `GPUQueue` or `GPUBuffer`,
in the library or in `WebKitWebProcess`. The port carries the scaffolding and does not
expose the API.

Also measured on that box, and needed by anyone reading this later:

| Fact | Value |
|---|---|
| `pkg-config --modversion webkit2gtk-4.1` | **2.52.5** |
| Tauri window on GNOME **Wayland** + NVIDIA 610.57.04 | **dies on first commit** — `wp_linux_drm_syncobj_surface_v1` error 2, "Explicit Sync only supported on dmabuf buffers". `GDK_BACKEND=x11` is required |
| The same crash in WebKitGTK's own `MiniBrowser` | **yes, byte-identical** — so it is the port, not Tauri or wry |
| `gtk3-widget-factory` on the same session | runs clean — so it is not GTK3 either |
| WebGL 2 renderer string in the webview | `Apple GPU` — WebKit's masked string, so hardware-vs-software is **not knowable** from it |
| `getUserMedia` inside the webview | `NotAllowedError` from wry's default permission handler; no prompt is drawn |

**Chrome 153.0.8010.36 on the same box, as a control:** `navigator.gpu` exists but
`requestAdapter()` returns **null** as launched — Chrome's GPU sandbox cannot open the
Vulkan ICD JSONs (`vkCreateInstance: Found no drivers!`) even though `vulkaninfo` reports
the RTX 5060 Ti as a conformant Vulkan 1.4 device. `--disable-gpu-sandbox` gives
`nvidia / blackwell`; `--enable-unsafe-webgpu` gives `google / swiftshader`, which is
software and passes a naive presence check. One box, one distro, one very new driver —
enough to decide Tauri-vs-Chrome, not enough to characterise Chrome on Linux.

Full detail and the quoted errors: `docs/spikes/E-tauri.md`.

### WebGPU on WebKitGTK was **not established** before the spike — kept for the record

This is the one fact P0-T08 turns on, and **no source consulted settles it**, so nothing
here asserts it. The WebGPU implementation-status wiki maintained by the GPU for the Web
working group lists Chromium, Firefox, Safari and Servo, and says of the WebKit entry only
that WebGPU is enabled by default "In macOS Tahoe 26, iOS 26, iPadOS 26, and visionOS 26" —
**every one of them an Apple platform**. WebKitGTK and WPE are absent from the page
entirely. Absence from a status table is not evidence of absence in the port, so this must
be a live call on the actual box rather than an inference.

**It matters more than anything else in the spike.** Three Phase 0 results depend on
WebGPU: Spike A measured synthesis at 947 ms on WebGPU against **3779 ms on wasm**, Spike D
found Smart Turn's int8 build will not load on WebGPU at all and fp32/WebGPU is the go
configuration, and Spike B's avatar wants a GPU path. If the Tauri webview on Linux has no
`navigator.gpu`, the voice pipeline on that platform is not slower — it is outside ADR-20's
500 ms budget by a factor of seven, and ADR-07's pre-written fallback ("that platform ships
as companion + Chrome/Edge") is the answer rather than a disappointment.

Check it **inside the Tauri webview**, never in a browser on the same machine — a Chrome on
that box proves nothing about WebKitGTK. Record the WebKitGTK version beside the answer
(`pkg-config --modversion webkit2gtk-4.1`), because this is a moving target and a bare yes
or no with no version against it will be worthless in six months.

## AI SDK v7 + OpenAI-compatible LLM (P1-T02) — 2026-09-11, verified against installed types and vendor docs

Dependencies in `packages/providers`: `ai@7.0.97`, `@ai-sdk/openai-compatible@3.0.47` (both MIT/Apache, recorded by `pnpm`). The streaming wire format (`reasoning`/`reasoning_content`, the `choices: []` usage frame, plain-text 404s, SSE framing) is verified **live against Ollama 0.32.15** by latentCreate's `crates/llm-bridge` (2026-08-24, `docs/LLM-SURFACE.md`); the AI SDK owns that parsing and this entry records what we depend on from it.

| Fact | Result | Source |
|---|---|---|
| Provider factory | `createOpenAICompatible({ name, baseURL, apiKey?, headers?, fetch?, includeUsage })` → `provider('model-id')`; a `fetch` option substitutes the transport for tests | ai-sdk.dev OpenAI-Compatible Providers |
| Streaming | `streamText({ model, messages, tools, abortSignal, temperature?, maxOutputTokens?, ... })` → `result.fullStream` of typed parts; `abortSignal` is the cancel seam (barge-in) | ai-sdk.dev streamText reference |
| Stream parts we map | `text-delta`(text), `reasoning-delta`(text), `tool-call`(toolCallId+toolName+input), `finish`(finishReason,totalUsage), `error`, `abort` | installed `ai` dist types |
| Reasoning | Reasoning streams arrive as a `reasoning-delta` part (text kept **out** of `text-delta`); `FinishReason` is `stop`\|`length`\|`content-filter`\|`tool-calls`\|`error`\|`other` (no `aborted` — an abort is a separate part) | ai-sdk.dev Reasoning, installed types |
| Usage | `LanguageModelUsage`: `inputTokens`/`outputTokens` are `number\|undefined`; cache tokens live under `inputTokenDetails.cacheReadTokens`/`cacheWriteTokens`, not top-level | installed types |
| Tool set | `tool({ description, inputSchema: jsonSchema(schema) })`; the schema field is **`inputSchema`**, not `parameters`, in v7 | installed types |
| Tool messages | A tool-result content part requires `toolName`; our protocol message carries only `callId`, so the provider resolves the name from the preceding assistant turn | installed types, our mapping |
| Message roles | `SystemModelMessage`(`content:string`), `UserModelMessage`(`content:string`), `AssistantModelMessage`(`content:string \| parts`), `ToolModelMessage`(`content:part[]`); a tool-result output is a typed `{type:'json'\|'text', value}` part | installed types |

**LLM preset base URLs (documented defaults, 2026-09-11).** Ollama `http://127.0.0.1:11434/v1` (live-verified via latentCreate surface); LM Studio `http://127.0.0.1:1234/v1` (ai-sdk.dev LM Studio page); vLLM `http://localhost:8000/v1` and llama.cpp `http://localhost:8080/v1` (standard server defaults, not yet live-tested here); OpenRouter `https://openrouter.ai/api/v1` (openrouter.ai docs/quickstart); NVIDIA NIM `https://integrate.api.nvidia.com/v1` (given in the P1-T02 plan; NIM docs); DeepSeek `https://api.deepseek.com/v1` (deepseek API docs); Kimi/Moonshot `https://api.moonshot.cn/v1` (platform.kimi.com docs).

## Native Anthropic and Google LLM providers (P1-T03) — 2026-09-11, verified by reading the installed `dist/index.d.ts` and each package's bundled provider docs

Dependencies in `packages/providers`: `@ai-sdk/anthropic@4.0.52`, `@ai-sdk/google@4.0.67`, on the same `ai@7.0.97` core as P1-T02. Neither package is generic the way `createOpenAICompatible` is, so neither needs a `ReturnType<...>` cast.

| Fact | `@ai-sdk/anthropic@4.0.52` | `@ai-sdk/google@4.0.67` |
|---|---|---|
| Factory | `createAnthropic(options?: AnthropicProviderSettings): AnthropicProvider` | `createGoogle`, also exported as `createGoogleGenerativeAI`, `(options?: GoogleProviderSettings): GoogleProvider` |
| Settings type | `AnthropicProviderSettings` | `GoogleProviderSettings` (alias `GoogleGenerativeAIProviderSettings`) |
| Settings fields used | `baseURL?`, `apiKey?` (sent as `x-api-key`), `headers?: Record<string, string>`, `fetch?: FetchFunction` | `baseURL?`, `apiKey?` (sent as `x-goog-api-key`), **`headers?: Record<string, string \| undefined>`**, `fetch?: FetchFunction` |
| Default base URL | `https://api.anthropic.com/v1` | `https://generativelanguage.googleapis.com/v1beta` |
| Model handle | provider is callable: `provider(modelId)` returns a `LanguageModelV4` | same |
| Model id type | `AnthropicModelId`, a union ending in `(string & {})`, so any string compiles | `GoogleModelId`, same shape |
| `FetchFunction` | **not exported** by either package; assign through `NonNullable<XProviderSettings['fetch']>` | same |
| Prompt caching | documented — `providerOptions.anthropic.cacheControl` breakpoints | documented — implicit caching, and explicit via `cachedContent` |
| Context window | **stated nowhere in the installed types or bundled docs** | **stated nowhere in the installed types or bundled docs** |

**Model ids in the curated catalogs, checked against the installed unions 2026-09-11.** Anthropic: `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5`. Google: `gemini-3.8-flash`, `gemini-3.5-flash`, `gemini-3.5-flash-lite`. The `claude-sonnet-4-5` / `claude-opus-4-1` and `gemini-2.5-*` families still compile but are previous generations and are deliberately not offered.

**Context length is where the two providers are recorded differently, on purpose.** Neither installed surface states a context window. Anthropic's `1000000` / `1000000` / `200000` come from Anthropic's published model table (cached 2026-06-24) and are **doc-sourced, not live-verified** — the confirming read is `GET /v1/models` → `max_input_tokens`, which needs a key and is producer-owned. Google's is `null` on every entry, because no source for it exists in the installed package at all and SURFACE 11 forbids presenting a guess as a fact. A `null` there is the honest answer, not a gap to fill in later from memory.

## TTS providers (P1-T05) — 2026-09-12, verified by reading the installed `kokoro-js@1.2.1`, OpenAI's published OpenAPI schema, and Kokoro-FastAPI's source

Three surfaces, three different kinds of evidence. None of it is from memory.

### kokoro-js 1.2.1 — read from `types/kokoro.d.ts` and `dist/kokoro.js` in `node_modules`

| Fact | Value |
|---|---|
| Load | `KokoroTTS.from_pretrained(model_id, { dtype, device, progress_callback })` |
| `dtype` | `"fp32" \| "fp16" \| "q8" \| "q4" \| "q4f16"` — note **`q8f16` is a file in the HF repo but not a value here** |
| `device` | `"wasm" \| "webgpu" \| "cpu" \| null`; `cpu` is the node backend and is unreachable from a browser worker |
| Stream | `stream(text: string \| TextSplitterStream, { voice, speed, split_pattern })` → `AsyncGenerator<{ text, phonemes, audio: RawAudio }>` |
| `RawAudio` | `{ audio: Float32Array, sampling_rate: number }` (from `@huggingface/transformers` `types/utils/audio.d.ts`) |
| Output rate | **24000 Hz, hard-coded** — `new RawAudio(waveform.data, 24e3)` in `dist/kokoro.js` |
| `speed` | supported on both `generate` and `stream`; there is **no emotion or style parameter at all** |
| Word timings | none. Nothing on this surface returns them |
| Package root exports | **only `KokoroTTS`, `TextSplitterStream`, `env`** — `VOICES` is *not* exported |
| Voices | 28, reachable only through a *loaded* model's `.voices` getter; each `{ name, language: "en-us" \| "en-gb", gender: "Female" \| "Male", traits?, targetQuality, overallGrade }` |
| `list_voices()` | **returns `void`** — it prints a table. A `listVoices()` built on it would return nothing |

The unexported `VOICES` is why `packages/ml-web/src/kokoro/voices.ts` carries a copy of the table: the settings UI has to list voices *before* the consent screen, and reading them from an instance would mean downloading 325 MB first. `voices.test.ts` parses the installed bundle and fails if the copy drifts.

### OpenAI `POST /v1/audio/speech` — read from `openai/openai-openapi` `openapi.yaml` (`CreateSpeechRequest`)

| Field | Type | Notes |
|---|---|---|
| `model` | string, **required** | `tts-1`, `tts-1-hd`, `gpt-4o-mini-tts`, `gpt-4o-mini-tts-2025-12-15` |
| `input` | string, **required** | max 4096 characters |
| `voice` | string or `{ id }`, **required** | built-ins: `alloy ash ballad coral echo fable onyx nova sage shimmer verse marin cedar` |
| `instructions` | string, max 4096 | **does not work with `tts-1` or `tts-1-hd`** |
| `response_format` | `mp3 opus aac flac wav pcm` | default `mp3` |
| `speed` | number | **0.25 – 4.0**, default 1 |
| `stream_format` | `sse \| audio` | default `audio`; `sse` is not supported for `tts-1`/`tts-1-hd` |

Response is `application/octet-stream` (the audio file) or `text/event-stream`. The SSE events are `speech.audio.delta` `{ type, audio }` where `audio` is base64, and `speech.audio.done` `{ type, usage }`.

**There is no listing endpoint for voices.** The spec's only `/audio/voices` is a `POST` that *creates* a custom voice. A voice list on this surface is configuration, not discovery.

### Kokoro-FastAPI — read from `api/src/routers/openai_compatible.py` and `api/src/structures/schemas.py` on `master`

- `POST /v1/audio/speech` takes the same `model` / `input` / `voice` / `response_format` / `speed`, plus `stream` (**default `true`**), `download_format`, `lang_code`, `volume_multiplier`, `normalization_options`.
- `response_format` is `mp3 opus aac flac wav pcm`; the schema's own words for `pcm` are "raw 16-bit samples without headers".
- Audio is written at **24000 Hz** (`StreamingAudioWriter(request.response_format, sample_rate=24000)`).
- `GET /v1/audio/voices` **exists here and not on OpenAI**. It returns `{"voices": [{"id", "name", …}], "default_voice": …}`, and `?legacy=true` returns the pre-0.3.x `{"voices": ["af_heart", …]}` plain-string shape. The adapter reads both.
- Its `wav` is written through PyAV in streaming mode, so **the `data` chunk size in the header cannot be final**. The parser in `packages/providers/src/tts/wav.ts` treats a declared size of `0` or `0xffffffff` as "read to the end" and every other value as an upper bound.

## Live provider verification — 2026-09-12, verified by live calls from the dev box

The "streaming works with a BYO key" criterion for P1-T02 and P1-T03, and the server half
of P1-T05. Run with `packages/providers/live/` (hand-run, never gated). **This is the first
time these ran: the earlier note that no live endpoint was reachable from this harness was
simply untested, and three tasks accumulated unevidenced done-whens behind it.**

### Every provider streams text, tool-calls and finishes

`temperature: null`, `maxOutputTokens: 2000`, one prompt for text and one offering a
`get_weather` tool.

| Target | Adapter | Model | text | tool | finish |
|---|---|---|---|---|---|
| Ollama local | OpenAI-compatible | `qwen3.5:9b` | ok | ok | stop / tool-calls |
| Ollama cloud | OpenAI-compatible | `qwen3.5:397b-cloud` | ok | ok | stop / tool-calls |
| LM Studio | OpenAI-compatible | `qwen/qwen3.5-9b` | **see below** | ok | length / tool-calls |
| NVIDIA | OpenAI-compatible | `nvidia/nemotron-3-super-120b-a12b` | ok | ok | stop / tool-calls |
| DeepSeek | OpenAI-compatible | `deepseek-v4-pro` | ok | ok | stop / tool-calls |
| QwenCloud | OpenAI-compatible | `qwen3.8-flash` | ok | ok | stop / tool-calls |
| Anthropic | **native** | `claude-opus-5` | ok | ok | stop / tool-calls |
| QwenCloud | **native Anthropic + custom `baseUrl`** | `qwen3.8-flash` | ok | ok | stop / tool-calls |
| Google | **native** | `gemini-3.5-flash` | ok | ok | stop / tool-calls |

In every case the tool call arrived as its own `tool-call` chunk with parsed arguments,
reasoning never appeared in a `text-delta`, and the run ended with `finish`. **The mapping
in `mapping.ts` is confirmed against nine live endpoints.**

The `baseUrl` row is the one with no other coverage: `createAnthropic({ baseURL })` had
never been exercised live. It works, and **the base URL must include the version segment** —
`https://dashscope-intl.aliyuncs.com/apps/anthropic` 404s, `…/apps/anthropic/v1` succeeds,
because the AI SDK appends `/messages`.

### A thinking model can spend the whole output budget on reasoning and say nothing

Observed twice, on two runtimes, and it is a product problem rather than an adapter one.

- **Ollama `qwen3.5:9b` with `temperature: 0`** — "Say hello in one short sentence."
  produced **1690 reasoning deltas, zero `text-delta`, `finish=length`**. Raising the budget
  from 300 to 2000 tokens did not help; it just thought longer. Dropping `temperature` to
  null fixed it immediately: 3 text deltas, `finish=stop`.
- **LM Studio `qwen/qwen3.5-9b`, `temperature: null`** — the same prompt produced **2000
  reasoning deltas, zero text, `finish=length`, in 89.7 seconds.** Its tool call on the same
  connection answered normally in 4.2 s.

Against ADR-20's 500 ms pipeline budget, a turn like that is not slow — it is silent. **Two
consequences for P1-T10:** never send `temperature: 0` to a model whose capabilities report
`thinking: true`, and treat "finished with `length` and no text" as a failure state the UI
must show, not an empty answer to speak.

### Anthropic context lengths, live-confirmed

`GET /v1/models` with `anthropic-version: 2023-06-01` reports `max_input_tokens`. The three
catalog values were doc-sourced (cached 2026-06-24) and a test asserted them; all three are
**correct**: `claude-opus-5` 1000000, `claude-sonnet-5` 1000000, `claude-haiku-4-5` 200000
(listed as `claude-haiku-4-5-20251001`; the undated alias resolves and streams).

The list also carries `claude-fable-5-1` and `claude-fable-5` at 1000000, which the curated
catalog does not offer. Not an error — a curation choice worth revisiting deliberately.

### Gemini context lengths, live-confirmed — and no longer `null`

`GET /v1beta/models` reports `inputTokenLimit`, which the installed `@ai-sdk/google` package
does not. All three catalog models report **1048576** (and `outputTokenLimit` 65536), so
`googleCatalog` now carries that number instead of `null`. Note it is 2^20 and **not** the
round 1000000 Anthropic reports for its own million-token models — the exact reason a guess
was refused in P1-T03.

### Kokoro-FastAPI, as actually deployed

`http://127.0.0.1:8880/v1`, model id **`kokoro`** (`kokoro_v1` is the engine name and is
rejected with `invalid_model`). `GET /v1/models` lists `tts-1`, `tts-1-hd`, `kokoro`,
`gpt-4o-mini-tts`.

- `GET /audio/voices` returned **72 voices** in the object shape, including families
  kokoro-js has no knowledge of — `ef_ ff_ hf_ if_ jf_ pf_ zf_` (Spanish, French, Hindi,
  Italian, Japanese, Portuguese, Chinese) and custom `*_inno` / `*_v0*` entries. The browser
  provider's 28-entry table and the server provider's live listing are **correctly different
  things**, which is the design.
- Synthesis returns 24000 Hz mono WAV; `wav.ts` decoded every response, and re-encoding the
  decoded `Float32Array` produces audio that plays correctly.
- **Real-time factor 0.25–0.41** on this box: 561 ms for 1.83 s of speech, 1538 ms for
  6.10 s. A first use of an unloaded voice costs about 2 s more.
- `speed: 1.5` shortened 1.83 s to 1.21 s — the ratio the parameter promises.
- An unknown voice returns 400 with the server's own message, which the adapter passes
  through verbatim, including the full list of available voices.

### What `maxChars` should be — measured 2026-09-12 against Kokoro-FastAPI

P1-T04 left the chunker's cap at 200 as a starting value. Sweeping input length from 19 to
559 characters, three runs each, median:

| chars | synth ms | audio s | RTF |
|---|---|---|---|
| 19 | 446 | 1.42 | 0.31 |
| 51 | 763 | 3.08 | 0.25 |
| 103 | 1525 | 6.0 | 0.25 |
| 219 | 3248 | 12.62 | 0.26 |
| 559 | 8554 | 32.04 | 0.27 |

The fit is close to a straight line through the origin: **`synth_ms ≈ 15.3 × chars`, with
no per-request overhead worth the name**, and speech comes out at **~17.4 characters per
second**. So synthesis runs about **3.8× faster than speech**, flat across the whole range.

**Two conclusions, and the second is the useful one.**

1. Because 15.3 ms of work buys 57.5 ms of playback, **every chunk after the first always
   arrives before the previous one finishes playing, at any chunk size.** Chunk length
   cannot starve the output queue. There is no latency argument for a smaller `maxChars`.
2. **`maxChars` does not touch the opening at all.** The first chunk of ordinary prose ends
   at a sentence boundary long before 200 characters, so 120, 200 and 320 produce an
   identical first chunk (103 characters here) and differ only in how a run-on sentence is
   broken later. **The cap is a safety valve, not a latency control — and 200 stays.**

The lever that does move time-to-first-audio is **a separate, smaller cap on the first
chunk of a turn**: 31 characters gave first audio at 581 ms against 1525 ms for the full
sentence. Even 500 ms only buys about 32 characters on this path, so **ADR-20's budget is
not reachable at sentence granularity here** — the opening has to be a clause, or the
budget has to be spent elsewhere. That decision belongs with the code that knows a turn has
started (P1-T08), and wants re-measuring on the browser path first.

**Superseded 2026-09-12, later the same day — this was a CPU number and it was 11.8x too
slow.** That instance had silently fallen back to CPU torch. Re-measured on the GPU below:
**1.29 ms/char**, and the first-chunk conclusion reverses. `maxChars = 200` still stands;
everything said about it above holds, because it all turns on the *ratio* of synthesis to
speech and the faster device only widens it.

## Kokoro ONNX graphs — Hugging Face blob listing, 2026-09-12

`GET https://huggingface.co/api/models/onnx-community/Kokoro-82M-v1.0-ONNX?blobs=true`,
exact bytes:

| file | bytes |
|---|---|
| `onnx/model.onnx` | 325,532,232 |
| `onnx/model_fp16.onnx` | 163,234,740 |
| `onnx/model_quantized.onnx` | 92,361,116 |
| `onnx/model_q8f16.onnx` | 86,033,585 |
| `onnx/model_q4.onnx` | 305,215,966 |
| `onnx/model_q4f16.onnx` | 154,586,422 |
| `onnx/model_uint8.onnx` | 177,464,632 |
| `onnx/model_uint8f16.onnx` | 114,209,226 |

**A dtype names a filename suffix, not a filename.** From
`@huggingface/transformers/src/utils/dtypes.js`, `DEFAULT_DTYPE_SUFFIX_MAPPING`:
`fp32` → `''`, `fp16` → `'_fp16'`, `q8` → `'_quantized'`, `q4` → `'_q4'`,
`q4f16` → `'_q4f16'`, `int8` → `'_int8'`, `uint8` → `'_uint8'`.

So **`dtype: 'q8'` fetches `model_quantized.onnx` (92.4 MB), never `model_q8f16.onnx`
(86.0 MB)** — despite the latter being the one whose name contains "q8". `KOKORO_BYTES` in
`packages/ml-web/src/kokoro/messages.ts` quoted 86,030,000 until this reading, understating
the consent screen by 6.3 MB. The number had been taken by matching a name in a file
listing rather than by resolving what the library actually requests: SURFACE 11's failure
mode with a plausible-looking source.

## Kokoro `fp32` against `q8` — measured 2026-09-12 (`docs/TASKS.md` C-5)

Both graphs loaded in one node process through `kokoro-js` 1.2.1 on **onnxruntime-node**,
voice `af_heart`, speed 1, three sentences chosen for where quantisation shows first
(plain, sibilant, long held vowels). `packages/ml-web/live/kokoro-dtype.ts`.

| measure | fp32 | q8 | delta |
|---|---|---|---|
| graph on disk | 325.5 MB | 92.4 MB | **−233 MB** |
| loudness (RMS) | −23.1 to −23.6 dB | −23.1 to −23.6 dB | ≤0.1 dB |
| noise floor, quietest 10% of frames | −121 to −168 dB | −122 to −167 dB | ≤1.1 dB |
| hiss in those frames (zero crossings) | ~12.4 kHz | ~12.4 kHz | ≤9 Hz, one outlier −389 Hz |
| duration drift | — | — | 0, +25, +50 ms per utterance |
| synthesis time | RTF 0.22–0.24 | RTF 0.76–0.80 | q8 **3.4× slower** |

**Two methodological notes, because both change what the table means.**

- **The takes are not sample-aligned.** Each graph predicts its own phoneme durations, so
  the two renderings differ in length by up to 50 ms and drift in phase. A sample-wise SNR
  or correlation is therefore meaningless however confident it looks — a first pass here
  reported −2.5 dB SNR, which measured only the misalignment. Every measure above is
  alignment-free for that reason.
- **q8 being slower is an onnxruntime-node artifact, not a fact about the browser.** The
  CPU execution provider dequantises int8 per operator. The browser provider runs on
  WebGPU, where the trade is different, and this says nothing about it.

**Finding: no measurable degradation where quantisation normally shows.** Same loudness,
same noise floor, same high-frequency content between words. What the measures cannot see
is timbre, and the duration drift is real — up to 50 ms per utterance, which will move word
timestamps and therefore visemes. The remaining question is perceptual and the WAVs in
`packages/ml-web/live/out/` are the evidence; no dtype default has been changed on the
strength of the numbers alone.

**Incidental finding for P1-T08: Kokoro's output is not bounded to [−1, 1].** `fp32` peaked
at **1.043** on one sentence and `q8` at 1.007 on the same one. Anything downstream that
assumes full scale — a WAV encoder, an AudioWorklet, a meter — has to clamp rather than
trust the range.

## Kokoro-FastAPI was not using the GPU — diagnosed 2026-09-12 (`docs/TASKS.md` C-4)

Rick's instance at `G:\Kokoro-FastAPI` (upstream `remsky/Kokoro-FastAPI`, `master`) was
serving from the CPU. `torch.__version__` in its venv: **`2.14.0+cpu`**, `cuda.is_available()`
false — against a `pyproject.toml` that pins `torch==2.8.0+cu128` for the GPU build.

**Cause.** Every CUDA wheel is gated on `platform_machine == 'x86_64'`, in
`[project.optional-dependencies]` and again in `[tool.uv.sources]`. On Windows
`platform.machine()` reports **`AMD64`**, so the marker is false on both, `[gpu-cu128]`
resolves to nothing, and uv satisfies `kokoro`'s unversioned `torch` dependency from PyPI —
the CPU build. It installs cleanly and runs; nothing fails. The 2.14.0 in place of the
pinned 2.8.0 is the tell that the pin never applied. Linux and macOS report `x86_64` and
are unaffected, which is why upstream has not seen it.

**The startup log cannot be used to check this**, and reading it wrongly is how the
instance ran on CPU unnoticed:

- `model_manager._determine_device()` is `"cuda" if settings.use_gpu else "cpu"` — it never
  asks torch. Its `Initializing Kokoro V1 on cuda` line reports the `USE_GPU` environment
  variable, nothing more.
- `settings.get_device()` does check `torch.cuda.is_available()`. Its
  `Loading Kokoro model on cpu` line is the true one.

**The two lines disagreeing is the signature of the bug.** Only the second is evidence.

**Fix applied** to `start-gpu.ps1` (backed up as `start-gpu.ps1.bak`): install
`torch==2.8.0+cu128` explicitly from `https://download.pytorch.org/whl/cu128` before
`uv pip install -e .`, which sidesteps the marker without editing an upstream file, then
fail the launch on a real kernel launch rather than on `is_available()` — a wheel built for
the wrong architecture imports and reports available, then dies on the first operator. cu128
is the Blackwell toolkit (sm_120) that the RTX 5060 Ti needs; cu126 carries no kernel for it.
`torch-2.8.0+cu128-cp312-cp312-win_amd64.whl` is present on that index, and nothing in the
tree constrains torch beyond `>=2.5`.

The upstream fix is to widen both markers to
`platform_machine == 'x86_64' or platform_machine == 'AMD64'`.

## The same sweep on the GPU — re-measured 2026-09-12 (`docs/TASKS.md` C-6)

Identical script, identical box, Kokoro-FastAPI now actually on the RTX 5060 Ti (sm_120)
after the CPU-torch fix below. 19–559 characters, three runs each, median.

| chars | synth ms (CPU) | synth ms (GPU) |
|---|---|---|
| 19 | 446 | **85** |
| 51 | 763 | **97** |
| 103 | 1525 | **119** |
| 219 | 3248 | **312** |
| 559 | 8554 | **757** |

**`synth_ms ≈ 14 + 1.292 × chars`** — a real per-request overhead of 14 ms appears, and the
per-character cost falls from 15.260 to 1.292 ms, **11.8x faster**. Worst real-time factor
across the sweep is **0.060**; speech still plays at ~17.4 chars/s, so synthesis now runs
about **44x faster than speech**.

**This reverses the first-chunk conclusion, which is the part that mattered.**

| budget | chars affordable, CPU | chars affordable, GPU |
|---|---|---|
| 245 ms (Spike A's synthesis share) | 17 | **178** |
| 500 ms (ADR-20) | 32 | **375** |

The full 103-character opening sentence now reaches first audio in **137 ms**, against
1525 ms before. So **"ADR-20's budget is not reachable at sentence granularity" was false,
and it was an artifact of a misconfigured server** — a whole sentence fits inside the
synthesis share with room to spare. **P1-T08 does not need a first-chunk cap on this
path.** The browser path is still unmeasured and gets its own reading.

One artifact worth noting: synthesis jumps 177 → 312 ms between 180 and 219 characters,
out of line with the fit. The server appears to split internally somewhere around 200
characters. It costs nothing at these speeds, but it is a reason not to read the intercept
as a per-chunk penalty we control.

## Kokoro-FastAPI `speed` — measured 2026-09-12

Rick reported that `speed: 1.5` "skipped words". Same sentence (91 characters) at six
speeds, on the GPU instance:

| speed | audio s | duration vs requested | chars/s of audio |
|---|---|---|---|
| 0.75 | 7.32 | — | 12.4 |
| 1.00 | 5.33 | 1.000 | 17.1 |
| 1.25 | 4.51 | 0.945 | 20.2 |
| 1.50 | 3.38 | **1.050** | **26.9** |
| 2.00 | 2.85 | 0.934 | 31.9 |
| 3.00 | 2.36 | **0.752** | 38.5 |

**Duration cannot detect this fault, which is why it needed an ear.** The server hits the
requested ratio to within ±7% up to 2.0 — at 1.5 it is *shorter* than asked (1.050), so
nothing is missing from the timeline; the phonemes themselves degrade. At 1.5 the audio
carries **26.9 characters per second**, past what the voice articulates, and Rick heard
words drop out. By 3.0 the server can no longer deliver the ratio at all (0.752).

**Usable range is about 0.75–1.25.** `OpenAICompatibleTTSProvider` clamps to the API's own
0.25–4 and should keep doing so — passing the server's contract through is right — but a
settings UI that offers the full range is offering something that does not work. Default
stays 1.

## `q8` against `fp32`, judged by ear — 2026-09-12

Rick could not tell the three pairs apart (`docs/TASKS.md` R-5), which matches the
measurements. **The default nevertheless stays `fp32`, for a reason the comparison could
not reach.**

The C-5 run used **onnxruntime-node**. The browser provider runs **WebGPU**, and this
project has already recorded one silent q8-on-WebGPU failure on this exact stack: ADR-20's
recognition entry notes that transformers.js's WebGPU q8 path for Moonshine "returns fluent
nonsense — the same string for every utterance — with no error". Quality equivalence on a
CPU execution provider is not evidence that the WebGPU one is correct, and the failure mode
on record is one no listener would hear as a defect until they read the words.

**So the quality question is closed and the deployment question is not.** What P1-T08 has
to settle, once it can run Kokoro in a browser: synthesise two different sentences at
`dtype: 'q8'` on WebGPU and confirm they differ from each other and match the node q8
durations. If they do, `q8` becomes the browser default and first-run drops from 325.5 MB
to 92.4 MB.

## Speech recognition through transformers.js 3.8.1 — verified 2026-09-12 (P1-T06)

Read out of the installed `@huggingface/transformers` source, then confirmed by running it
(`packages/ml-web/live/stt.ts`). Every item here would have been wrong from a reasonable
assumption.

**The ASR pipeline does not resample.** `prepareAudios` (`src/pipelines.js`) passes a
`Float32Array` straight through; its `sampling_rate` argument is used only for input it has
to decode itself. Handing it the wrong rate is not an error. Measured on one sentence:

| source rate, read as 16 kHz | Moonshine tiny | Whisper base |
|---|---|---|
| 24 kHz (1.5x) | perfect | perfect |
| 48 kHz (3.0x) | **empty result** | **"I'll spawn on your top of your ears for cash."** |

48 kHz is what a browser microphone gives by default. Neither case reported anything.

**A Seq2Seq model downloads exactly two graphs.** `constructSessions` (`src/models.js`)
asks for `encoder_model` and `decoder_model_merged`, and nothing else. The non-graph files
fetched are exactly `config.json`, `generation_config.json`, `preprocessor_config.json`,
`tokenizer.json` and `tokenizer_config.json` — **not** `vocab.json`, `merges.txt`,
`normalizer.json`, `added_tokens.json` or `special_tokens_map.json`, all of which sit in the
repos. Summing the listing's JSON overstates `whisper-base` by **1.63 MB**. Confirmed by
downloading into an empty cache: `moonshine-tiny` q8 is **32,079,632** bytes and
`whisper-base` q8 is **79,664,191**.

**`onnx-community/whisper-*` cannot produce word timings.** Any request for them throws:

> Model outputs must contain cross attentions to extract timestamps. This is most likely
> because the model was not exported with `output_attentions=True`.

The `_timestamped` variants of the same repos do work, and are within 23 KB of the same
size (`whisper-base_timestamped` q8 is 79,641,437 against 79,664,191). **A provider
advertising `wordTimestamps: true` against the plain export fails on every utterance**, so
the catalog names the `_timestamped` repos.

**Moonshine reports text and nothing else.** `_call_moonshine` returns `{ text }` — no
chunks, no timestamps, no language — whatever options it is given.

~~**Moonshine's token budget does not need rescuing.**~~ **Wrong, corrected 2026-09-13 —
see "Turn detection" below.** `_call_moonshine` computes `max_new_tokens` as
`Math.floor(seconds) * 6`. This entry tested one 0.48 s "Yes." (budget 0, which came back
as "Yes") and concluded the budget was safe. It is not: **one to two seconds gets six
tokens**, and a normal sentence loses its last words. What *was* right: **forcing a floor
of 24 tokens made Moonshine answer "Yes, yes, yes."**, so the fix is not a generous floor.

**Whisper does not surface its detected language.** `WhisperForConditionalGeneration`
consumes the detection internally and 3.8.1 exports no `detect_language`, so a browser
Whisper provider can honestly report `languageDetection: false` only.

**Cancellation mid-generation works.** `InterruptableStoppingCriteria` is exported from
`generation/stopping_criteria.js`, and both `_call_whisper` and `_call_moonshine` spread
their kwargs into `model.generate`, so `stopping_criteria` reaches it. An interrupted
generation **returns normally with a truncated result rather than throwing**, so the caller
has to check the flag or it will deliver a partial transcript as if it were complete.

### Recognition accuracy, measured end to end

Kokoro synthesises a known sentence, the recogniser transcribes it, word error rate is
computed against the text that was spoken. `q8` on onnxruntime-node:

| model | WER | time | RTF | word times |
|---|---|---|---|---|
| moonshine-tiny | 0% on both sentences | 118–139 ms | 0.03 | none, by design |
| whisper-base (timestamped) | 0% on both sentences | 754–817 ms | 0.19–0.22 | 9 and 16 |

Moonshine is **six times faster** for the same transcript on this path. Neither number says
anything about WebGPU, which is where the pipeline actually runs.

## OpenAI `/audio/transcriptions` — verified 2026-09-12 against `openai` 2.53.0

From the official client's source (`resources/audio/transcriptions.py`,
`types/audio/*.py`, `_base_client.py`), not from documentation prose.

- **multipart/form-data**, `file` a real file part. Content-Type must be left to the HTTP
  client so the boundary is generated.
- Fields: `file`, `model` (both required), then `language`, `prompt`, `response_format`,
  `temperature`, `timestamp_granularities`, plus newer `chunking_strategy`, `include`,
  `keywords`, `languages`, `stream`.
- `response_format` is one of `json`, `verbose_json`, `text`, `srt`, `vtt`.
- **Arrays are serialised with brackets** — `_serialize_multipartform` uses
  `array_format="brackets"`, so the field is `timestamp_granularities[]`, repeated once per
  value.
- `json` returns `{ text, languages?, logprobs?, usage? }`. **Word timings only exist in
  `verbose_json`**, which returns `{ duration, language, text, segments?, words?, usage? }`.
- `TranscriptionWord` is `{ word, start, end }` with **start and end in seconds**.
- Neither response format carries a confidence.

## Turn detection promoted — verified 2026-09-13 (P1-T07)

`pnpm live:turn` (`packages/ml-web/live/turn.ts`) runs the shipped `SileroVad` and
`SmartTurnModel` modules — the ones the workers load — into the real `TurnDetector`, on
twelve Kokoro utterances over digital silence and over a −46 dBFS noise floor. Full report
in the gitignored `live/out/turn.md`.

### Models, pinned

| Model | Revision | File | Bytes | Licence |
|---|---|---|---|---|
| `onnx-community/silero-vad` | `e71cae96…` | `onnx/model.onnx` | **2,243,022** | MIT |
| `pipecat-ai/smart-turn-v3` | `f766f81d…` | `smart-turn-v3.2-gpu.onnx` (fp32) | **32,411,198** | BSD-2-Clause |
| `pipecat-ai/smart-turn-v3` | `f766f81d…` | `smart-turn-v3.2-cpu.onnx` (int8) | **8,679,182** | BSD-2-Clause |

From the HF tree API at those revisions, Silero also by `X-Linked-Size`, and **all three
confirmed by downloading** (the live check refuses a file whose length differs). URLs are
pinned to the commit, not `main`, so the consent size cannot drift under a user.

### `onnxruntime-web` runs in node

`onnxruntime-web@1.22.0-dev.20250409-89f8206ba4` has a `node` export condition
(`dist/ort.node.min.mjs`) and runs both graphs on the wasm backend under vite-node. That is
what lets the live check run the shipped model code instead of a copy. Its types do not
resolve through the `exports` map under `moduleResolution: bundler`, so
`packages/ml-web/tsconfig.json` carries the same `paths` entry `apps/web` already did.

### Silero's reference input is 576 samples, not 512

`snakers4/silero-vad`, `src/silero_vad/utils_vad.py`, `OnnxWrapper.__call__`: at 16 kHz it
requires 512-sample chunks and **prepends the previous call's last 64 samples** before
running the graph (`context_size = 64`), starting from zeros. Spikes A and D fed the bare
512. Both run on the same audio:

- mean per-frame |Δp| **0.02–0.09**; peak p unchanged (≥0.98 either way);
- with context, **speech onset is detected up to 64 ms earlier** (+8/+40 ms against
  +40/+72/+104 ms);
- over the noise floor the bare frame calls speech-end **up to 107 ms early**, clipping
  final syllables and cutting candidates early; with context the worst is −62 ms.

`SileroVad` follows the reference. `{ context: false }` exists only to reproduce the spikes.

### Silero fires on synthesised speech

The brief's caveat — no room tone, no breath — did not bite. Every utterance was detected in
both conditions, onset within +8 to +40 ms of the label (one −24 ms, noise-triggered) and
end within ±62 ms. **No microphone fallback was needed for the VAD.**

### Smart Turn in node, and the endpoint

| | silence | noise |
|---|---|---|
| complete sentences ended at their end by the model | 6 of 6 | 6 of 6 |
| interrupted | 0 | 0 |
| retractions (ADR-25) | 4 | 3 |
| end of turn after labelled end, WebGPU latency (median / worst) | **168 / 188 ms** | **172 / 220 ms** |
| same at measured node-wasm latency | 417 / 459 ms | 411 / 455 ms |
| late answers at node-wasm latency | 0 | 0 |
| WER of the audio kept for recognition (Moonshine tiny q8, worker budget) | **0.0%** | **0.0%** |

"WebGPU latency" is Spike D's 40 ms from cut to answer, applied on the audio clock — **not
a browser measurement**. fp32 on node wasm, one thread: log-mel + graph **median 279 ms,
worst 356 ms**; Silero **0.26 ms** per frame.

### Kokoro pauses mid-sentence, and Smart Turn believes the prefix

"The afternoon light came in low across the desk." contains **~220 ms of digital zero**
(rms 0.000) after "light". Smart Turn scored "The afternoon light" 0.96; similarly "Can you
remind me" 0.98, "That was the best meal" 0.95, "I think we should paint the" 0.79. At a
40 ms answer the turn ended inside the pause and the transcript was the prefix; at 280 ms
the answer arrived after speech resumed and was ignored. **Before ADR-25, 4 of 6 complete
sentences were cut off at WebGPU speed** and none at node speed.

### Synthetic "incomplete" utterances are not held pauses

Kokoro speaks a fragment with finished-sentence prosody — Moonshine even punctuates "The
thing about the old house is that." So 3 of 12 fragments fired (0.94/0.98, and 0.78 in
noise); the rest scored 0.006–0.30. Spike D's 0 of 51 was a human trailing off and
holding. **This check cannot measure false fires on held pauses**; it measures endpoint
timing on finished speech and the mechanics around it.

### fp32 and int8 disagree, as recorded

Same audio: "I think we should paint the kitchen" 0.360 against 0.653; "That was the best
meal" 0.727 against 0.559; "I was thinking that maybe we could" 0.095 against 0.393. The
builds do not share a threshold, confirming the 2026-09-08 entry.

### Moonshine's library token budget truncates one-to-two-second speech

transformers.js 3.8.1 `src/pipelines.js:1932`:
`const max_new_tokens = Math.floor(aud.length / sampling_rate) * 6;`, overridable by the
caller's kwargs. Fifteen Kokoro sentences, each with the 128 ms of silence a candidate
window carries:

| budget | exact transcripts | e.g. |
|---|---|---|
| library `floor(s) * 6` | 6 of 15 — all eight from 0.9 to 2 s truncated, and one at 2.75 s | "Could you turn the music down" (1.68 s, 6 tokens); "Okay" for "Okay, sure." (0.90 s, 0 tokens) |
| `ceil(s * 6)` | 14 of 15 | the miss is "station, that", identical at every budget |
| `ceil(s * 6) + 2`, `ceil(s * 8)` | 14 of 15 | no transcript changed |

`asr.worker.ts` now sends `moonshineTokenBudget` = `ceil(seconds * 6)` for Moonshine.
**Moonshine emits its end token only when silence follows the last word**: a "Yes." trimmed
to the waveform (0.48 s, budget 3) comes back "Yes, yes"; the same word as `TurnDetector`
hands it over — 300 ms pre-roll, 128 ms tail, 0.91 s, budget 6 — comes back "Yes.". Only the
second shape occurs in the product. `live:stt` reports both.

## Claude desktop Browser pane — probed 2026-09-13 (for P1-T08)

One `javascript_exec` in the Code tab's Browser pane on Rick's Windows box, at
`https://example.com` (a secure context; `navigator.gpu` needs one):

| Probe | Result |
|---|---|
| User agent | `Chrome/152.0.7977.76`, `Claude/1.52386.3`, MSIX |
| `navigator.gpu.requestAdapter()` | `nvidia` / `blackwell`, `isFallbackAdapter` **false** |
| `AudioWorkletNode` | present |
| `'outputLatency' in AudioContext.prototype` | true |
| `SharedArrayBuffer` | **undefined** (no COOP/COEP on that origin — Spike E's finding again) |

**Consequence:** the browser-only questions `docs/TASKS.md` parked — Kokoro `q8` on WebGPU,
Kokoro's first-sentence time on WebGPU, Smart Turn's WebGPU answer latency — can be run by
the architect in the pane against the dev server. It is a real discrete adapter, not
SwiftShader, so a number taken there is a GPU number. What the pane cannot supply is a
microphone with a person behind it or ears on speakers. Not yet checked: whether it grants
`getUserMedia`, and what `outputLatency` actually reads once a context is running.

## The voice pipeline in a browser — verified 2026-09-13 (P1-T08)

All in the Claude desktop app's Browser pane (Chrome 152.0.7977.76, `nvidia / blackwell`
WebGPU adapter, page **hidden** throughout), against the Vite dev server and `/dev/voice`.
Every model ran through the promoted workers in `packages/ml-web`, not spike code.

**Vite 8.2.2 bundles an AudioWorklet with `?worker&url`, in dev and in a build.** Read out
of `vite/dist/node/chunks/node.js` (the `vite:worker` plugin), then run: a TypeScript
processor in `packages/providers` imported as `./x.worklet.ts?worker&url` loaded in
`AudioWorkletGlobalScope` from the dev server — the `import "/@vite/env"` Vite injects into
module workers is harmless there — and from `vite build` + `vite preview`, where it is
emitted as its own IIFE asset. `new URL('./x.ts', import.meta.url)` is only rewritten for
`new Worker(...)`, so it is not an option for `audioWorklet.addModule`.
`new AudioContext({ sampleRate: 24000 })` is honoured; `outputLatency` reads 0 until the
context has rendered, then **40 ms**; `baseLatency` 10 ms.

**Kokoro `q8` on WebGPU is broken, silently.** Three sentences through `kokoro.worker.ts`
(voice `af_heart`), each transcribed back by Moonshine tiny fp32 on WebGPU:

| | durations (ms) | against node's | Moonshine read | RMS | zero crossings |
|---|---|---|---|---|---|
| fp32, WebGPU | 3400, 4525, 3400 | fp32: 3400, 4525, 3400 — identical | all three, word for word | −23.1 dB | 2515 Hz |
| q8, WebGPU | 3500, 4825, 3950 | q8: 3425, 4575, 3400 — up to +550 | **nothing, in all three** | −25.6 dB | 2069 Hz |

The q8 audio is speech-shaped — Silero calls it speech and 94 of 96 voiced 20 ms frames line
up with node's — so nothing short of a transcript notices. To rule out the recogniser, the
same browser Moonshine read node's `plain-q8.wav` exactly. **Every quantised Kokoro
precision is now refused on WebGPU**, in the provider constructor and in the worker.
fp32 warm synthesis: 337 ms for 3.4 s of speech, 690 ms for 4.5 s. fp32 peaks at **1.11**.

**Kokoro pads every sentence: ~310 ms of silence in front, ~490 ms behind**, measured in the
browser (285–316 ms lead) and in node (298–338 ms lead, 433–538 ms tail, eight sentences),
with the first and last samples at rest (|x| < 1e-6). The first audible word of an answer
therefore arrives ~310 ms after its first frame, which is what Spike A timed as "first
audio". `Reply` now trims each sentence to its voice plus 50 ms / 250 ms (ADR-27).

**Chrome slows an AudioContext whose output is digital silence, after ~30 s.** Four 16 kHz
contexts side by side in the hidden page: all rendered at 1.00× real time for 30 s; then
the two whose output was exactly zero (one plain, one running the capture worklet) fell to
**0.64×** between 30 and 35 s and stayed there, while a 200 Hz tone at −60 dB and one at
**−100 dB** held 1.00× for the full minute. The capture context outputs zero by design, so
within a minute of listening microphone frames were arriving 10 s late and barge-in with
them. With a −100 dB keep-alive tone on both contexts (`keepAlive` in `create-audio.ts`),
120 s and 14 barge-ins held 1.00× and 20–22 ms frame lag throughout. **Not measured with the
page visible**; the pane was hidden the whole time.

**Smart Turn fp32 on WebGPU: 8–57 ms warm, 392–479 ms for the first inference** of a
session, which landed after the hangover as `late`. The worker now runs one throwaway
judgement during load (a quiet chord: all-zero input has no log-mel span and
`SmartTurnModel` refuses it). Spike D's 40 ms figure is reproduced on this onnxruntime
version. It scored Kokoro `am_michael`'s "What was the afternoon like?" at 0.02–0.03 every
time and "Sorry, can I stop you there for a second?" at 0.99.

**Output, recorded from the worklet itself: no clicks.** 204 s of rendered samples across
17 sentence starts, 56 ends (dropped queue included), 13 ducks and 26 fades. The largest
step within 5 ms of any event, over the largest step of the voice in the 50 ms before it:
at most **1.12** (a fade), where a hard cut on a voiced sample scores many times over.
Every fade reached exact digital zero **at 100 ms**. Nothing hit the ±1 clamp in that run.

**The first browser reading of ADR-20's pipeline: ~765 ms, not 500.** Eleven turns on
`/dev/voice`, simulated speaker saying "Sorry, can I stop you there for a second?", Smart
Turn warm, a scripted model that costs nothing, from the turn's last speech frame to the
first answer frame at the ear (output latency included):

| turn | speech end → first audio | first sentence synthesis |
|---|---|---|
| 1 (first of the session) | 1096 ms | 544 ms |
| 2–11 | **718–811 ms**, median ~765 | 369–403 ms |

Turn ends landed 194–279 ms after speech. The largest single cost is synthesising the
answer's first sentence — 84 characters, ~4.6 ms each on Kokoro fp32/WebGPU — where D-12
found 1.29 ms/char on the GPU server path. **A first-chunk cap is back on the table for the
browser path**; P1-T08 records the number and leaves the prosody call to the task that
judges the budget (P1-T14). ADR-25's 500 ms hold never bound in these turns: synthesis
finished after it every time. The first frame now carries 50 ms of lead (ADR-27), so the
first voiced sample is ~50 ms later than the table.

## Spoken-prefix estimate against a listener — measured 2026-09-13 (P1-T08, `pnpm live:bargein`)

Kokoro q8 `af_heart` on onnxruntime-node, eight sentences × eight seeded cuts inside the
voiced range, each followed by the worklet's 100 ms linear fade, then Moonshine tiny q8
transcribing what was left (300 ms lead, 500 ms tail). The estimate is asked at the fade's
midpoint, as `Reply` asks. **12 of 64 cuts came back from Moonshine empty** — one of them
2.6 s of clear speech — and are scored as unreadable, not as the estimate running ahead;
the first run scored them the other way.

| estimator, 52 readable cuts | exact | behind 1 | behind 2+ | ahead 1 | ahead 2+ | mean abs diff |
|---|---|---|---|---|---|---|
| **voiced range, fade midpoint (ships)** | 18 | 30 | 0 | **4** | 0 | **0.65** |
| whole padded sentence, fade midpoint | 11 | 17 | 22 | 2 | 0 | 1.27 |
| voiced range, fade start | 13 | 33 | 3 | 3 | 0 | 0.81 |

Of the four "ahead" rows, two are Moonshine mishearing ("there is none" for "there was",
"bluefold" for "blue folder") and **two are real**: "because" claimed just after
"anything," — Kokoro pauses at a comma and a character-proportional estimate does not know
it. "Behind 1" is mostly Moonshine completing a word the fade cut in half, which the
estimator deliberately does not count. Spreading words over the padding is clearly worse,
which is the measured reason for `voicedRange`.

## Echo cancellation and the microphone path — heard 2026-09-13 (R-2, Rick's Windows box)

Rick at `/dev/voice` in a Chromium browser, Realtek(R) Audio microphone, requested with
`echoCancellation`, `noiseSuppression` and `autoGainControl` all `true`
(`packages/providers/src/audio/create-audio.ts`). Raw output and reading:
`docs/runs/R-2-voice-2026-09-13.md`.

**Chromium's AEC removes this page's own Web Audio output from the `getUserMedia` stream
completely** on that machine: a 16.2 s answer played through speakers at normal volume with
the microphone live, and Silero never reached `speechOn` — no duck, let alone a barge-in.
Web Audio output is inside the cancellation loopback, which was the open question. A cough
over the voice did not reach `speechOn` either. One machine, one room, one volume.

**The capture context's clock appears to step when the output device changes** (inferred,
not isolated). After headphones were swapped for speakers, frame time (capture `currentTime`
mapped through a `performance.now()` offset taken once at start) read a constant 154 ms
behind, returning to 154 — not 0 — after a 688 ms stall, which a backlog that could catch up
would not do. Anything that compares capture-frame time with another clock must re-derive the
offset; `VoiceSession` compares frame time only with frame time and is unaffected.

## Kokoro and backchannels — measured 2026-09-13 (P1-T09, `pnpm live:backchannel`)

kokoro-js 1.2.1, `onnx-community/Kokoro-82M-v1.0-ONNX` q8 on onnxruntime-node, `af_heart` and
`am_michael`; Whisper base q8 as a cross-check. Clips written to `live/out/backchannel/`.

**Nonverbal spellings are read as letters.** The phonemes kokoro-js produced:

| text | phonemes | Whisper (af_heart) |
|---|---|---|
| Mm-hmm. | /ˌɛmˈɛmhəm/ | "M.M.Hum" |
| Mhm. | /ˌɛmˌeɪtʃˈɛm/ | "M H M" |
| Mm. | /ˌɛmˈɛm/ | "M-M." |
| Hmm. | /hˈəm/ | "PAMS!" |
| Uh-huh. | /ˈʌhˈʌ/ | "As high." |
| Mmhmm. / Hm. / Mmm. (one run) | /ˌɛmˌɛmˈeɪtʃˌɛmˈɛm/, /ˌeɪtʃˈɛm/, /ˌɛmˌɛmˈɛm/ | letters |

**Words phonemize as themselves**, voiced length af_heart / am_michael: Yeah. /jˈɛə/ 395 / 414
ms, Right. /ɹˈaɪt/ 473 / 503, Yes. /jˈɛs/ 462 / 498, Oh. /ˈoʊ/ 351 / 408, Sure. 415 / 445,
Okay. 524 / 624, I see. 563 / 618 — every one transcribed back correctly. Each rendering
carries ~360–410 ms of silence in front and ~410–570 ms behind, as sentences do (ADR-27).
**Raw phonemes bypass the phonemizer** — `tts.tokenizer(phonemes)` then
`generate_from_ids` — and /mˈhm/ renders 417 ms of voice; whether it sounds like "mm-hm" is
for an ear, and `TTSProvider` has no phoneme input, so it is not used.

**`tts.stream(text)` with a string never finishes in kokoro-js 1.2.1.** It wraps the string
in a `TextSplitterStream`, pushes it and never calls `close()`, so `for await` waits forever
and node exits with code 0 and no output once the event loop drains. Pass a closed
`TextSplitterStream`, which `kokoro.worker.ts` already does.

**Browser synthesis of the clips matches node**: "Yeah." 483 ms, "Right." 571, "Yes." 563,
"Oh." 449 after trimming to 50 ms either side (node: 495, 573, 562, 451).

## Backchannels in a browser — measured 2026-09-13 (P1-T09, `/dev/voice`)

Claude desktop Browser pane, WebGPU, page hidden; the harness's simulated speaker (Kokoro
`am_michael`) telling a five-phrase story with silences written between phrases. Three runs:
the first with clips cut on speech and pauses of 450/300/450/450 ms, then duck and cut with
350/300/250/350 ms.

- **A clip starts 194–227 ms into a pause** (candidate at 128 ms, Smart Turn 7–48 ms).
- **Written pauses read longer to the detector**: 450 ms of written silence after a phrase
  ending "…and" twice ran into the 512 ms hangover, and 300 ms once did. The VAD's speech end
  sits before the word's quiet tail, so the detected pause is the written one plus that tail.
- **All 5 clips started in a mid-turn pause were talked into before they finished**, 9–298 ms
  after being queued. Cut: "Yes." at 231 ms, "Oh." at 253 ms (about two thirds of the word),
  "Right." at 9 ms (none of it). Ducked: "Yes." and "Oh." played their full 563 / 449 ms.
- **Smart Turn scores**: pauses between phrases 0.01–0.64, all under the threshold; commas
  inside a phrase 0.74–0.97, ended and retracted (ADR-25) every time; the story's last
  sentence 0.97 once and 0.05–0.06 twice, where a backchannel played just before the answer.
- **Rate limit held**: clips 9.5–9.7 s apart; every sub-threshold answer inside 8 s skipped.
- **0 clicks**: 18 events with two ducks and two unducks (unduck 8–10 ms after its clip's last
  frame, worst step 0.27× speech), 16 events with two 50 ms cuts (worst 0.72×).

## Backchannels with a person — heard 2026-09-13 (R-4, Rick's Windows box)

Chromium, Realtek(R) Audio microphone, `/dev/voice`; a duck session (the simulated story,
then ~65 s of Rick talking on headphones) and a cut session (~68 s on the microphone).
`docs/runs/R-4-backchannels-2026-09-13.md`.

- **A person's mid-turn pauses are as short as Kokoro's**: both microphone clips started
  inside a turn were talked into, 21 and 181 ms after being queued, and the cut session's
  one clip at 73 ms. With the story and P1-T09's runs: 10 of 10.
- **Rate**: 4 clips in ~65 s with a person (14.2–21.6 s apart), 1 in ~68 s when the turns
  were short — `minSpeechMs` and answering, not the 8 s limit, set the rate there.
- **A clip before the answer**: 3 of the duck session's 7, each on a Smart Turn score of
  0.01–0.39 followed by the hangover 310 ms later; the answer's audio came ~190–300 ms after
  the clip ended. Heard as natural.
- **By ear**: no word sounded wrong; duck preferred to cut; no speaker pickup.

## LLM endpoints from a browser — measured 2026-09-14 (P1-T10)

Every earlier LLM check ran in node, which does not enforce CORS, so none of this was known.
Two passes: node sending a preflight (`OPTIONS`, `Access-Control-Request-Method: POST`, the
headers each adapter sends) and a real `GET /models`, each with `Origin:
http://localhost:5173` and `Origin: https://app.latentpresence.com`; then the same calls from
the dev server's page in Chrome 152.0.7977.76 (Claude desktop Browser pane).

| Endpoint | Page on localhost | Hosted app | What the response said |
|---|---|---|---|
| Ollama 0.34.0 (local) | **allowed** | **403**, no headers | Reflects the origin; default list is `localhost`, `127.0.0.1`, `0.0.0.0` (http/https, any port) plus `app://`, `file://`, `tauri://`, `vscode-webview://`, `vscode-file://` — `envconfig/config.go`. `OLLAMA_ORIGINS` adds to the defaults. `http://tauri.localhost` (WebView2's origin) also got 403 |
| LM Studio (local, CORS off) | **blocked** | **blocked** | 200 with no `Access-Control-*` at all. Fix: "Enable CORS" in its server settings, or `lms server start --cors` (lmstudio.ai docs) |
| vLLM | not running | — | `--allowed-origins` default `['*']`, methods and headers `['*']` (docs.vllm.ai `serve`) |
| llama.cpp `llama-server` | not running | — | `--cors-origins` default `*`, credentials enabled; localhost-only when `--tools`/`--agent` (tools/server README) |
| OpenRouter | allowed | allowed | `Access-Control-Allow-Origin: *` |
| **NVIDIA `integrate.api.nvidia.com`** | **blocked** | **blocked** | **No `Access-Control-Allow-Origin` on preflight or response**, for `/v1/models` and `/v1/chat/completions` |
| DeepSeek | allowed | allowed | Reflects the origin; preflight allow-methods lists only `POST` (GET is safelisted, so it still passes) |
| Kimi (Moonshot) | allowed | allowed | Reflects the origin, allows `authorization,content-type` |
| QwenCloud (OpenAI-compatible) | allowed | allowed | `*` |
| Anthropic | **blocked** without the header | same | Preflight **400**, no allow-origin. With `anthropic-dangerous-direct-browser-access: true`: 200, `*`. `@ai-sdk/anthropic` 4.0.52 does not send it; the adapter now does |
| Google Gemini | allowed | allowed | Reflects the origin, allows `x-goog-api-key` |
| Kokoro-FastAPI (TTS) | not running | — | `cors_enabled = True`, `cors_origins = ["*"]` by default (`api/src/core/config.py`) |

**A page cannot tell a CORS refusal from a dead server.** Chrome reports both as
`TypeError: Failed to fetch`. A second request with `mode: 'no-cors'` separates them: it
**resolved** (opaque, status 0) for LM Studio with CORS off, NVIDIA and Ollama, and
**rejected** for a closed port, `localhost:8000` with nothing on it and an unresolvable host.
An unroutable address (`10.255.255.1`) hangs rather than fails, so every probe needs a
deadline. `probeEndpoint` in `packages/providers/src/access` is this, run in the page.

**A model list proves nothing about a key on two of them.** `GET /v1/models` answered **200
with no key and with a bad key** on NVIDIA and OpenRouter. DeepSeek, Kimi and Anthropic: 401
without a key; Anthropic and DeepSeek 401 with a bad one. Google: **403** without, **400**
with a bad key.

**Key storage.** In the same page: a non-extractable AES-GCM 256 `CryptoKey` stored in
IndexedDB survived a reload as a `CryptoKey` (`extractable: false`) and decrypted what it had
encrypted into `localStorage`; `exportKey` on it threw `InvalidAccessError`.

**The relay (ADR-29), live.** With the companion on 127.0.0.1:8787: the page's
`probeEndpoint` on `/health` answered 200; NVIDIA direct was `cors-blocked`, through
`relayFetch` `answered` 200, and `listModels()` returned 82 models (17 Nemotron). A relay
request naming Ollama came back 403 `target not allowed`. From node through the relay with
the key, `nvidia/nemotron-3-super-120b-a12b` streamed "ready" (first text 1173 ms), and an
abort after five deltas ended the stream 4 ms later. That the upstream connection closes on
abort is proven against a local stream in the companion's tests, not against NVIDIA's side.

**The bundle.** Importing anything from `@latentpresence/providers`'s root put
`ort-wasm-simd-threaded.jsep.wasm` in the production build and the guard failed — the root
re-exports the browser STT/TTS/turn providers, which import ml-web. The app imports
`@latentpresence/providers/web` and `@latentpresence/ml-web/voices`.

**Not measured:** Firefox and Safari; Chrome Local Network Access prompts from the hosted app
to the companion or Ollama (P8-T03); vLLM and llama.cpp on running servers; whether NVIDIA
stops generating when the relay drops the connection.

**Addendum, later the same day (P1-T10's page).** LM Studio on this box then answered
`Access-Control-Allow-Origin: *` and `Access-Control-Allow-Headers: *` with a 200 preflight —
its CORS had been switched on. That is what "Enable CORS" produces, and the settings page
reported it as connected (4 models).

## System prompts and inline tags — measured 2026-09-14 (P1-T12 planning pilot)

**AI SDK 7 refuses a `system` message inside `messages`.** `ai` 7.0.97 throws
`AI_InvalidPromptError: System messages are not allowed in the prompt or messages fields. Use
the instructions option instead.` before any request is sent (`standardize-prompt.ts`,
`allowSystemInMessages` defaults to false). Nothing had sent a system prompt until this
pilot, so every adapter would have failed on the first persona. Fixed in
`packages/providers/src/llm/mapping.ts` (`toAiPrompt`): system messages are joined into
`instructions`; the OpenAI-compatible adapter then puts them on the wire as the first message
(tested against a captured request body).

**Pilot: do models follow a `[emote:x]` / `[gesture:x]` instruction?** A draft system prompt
(Alice on a video call; short spoken sentences, no markdown, lists, emoji or stage directions;
one emote near the start from the twelve `CharacterEmotion`s; gestures sparingly from `nod,
shake-head, shrug, wave, tilt-head, lean-in, open-hands, think`), six varied user turns with
history, `temperature: null`, `maxOutputTokens: 1500`, output parsed by the shipped
`SentenceChunker`. Throwaway script, not committed.

| Model | Turns with text | Emote tags | Gesture tags | Off-list | Leaked markup |
|---|---|---|---|---|---|
| `nvidia/nemotron-3-super-120b-a12b` (NVIDIA) | 6/6 | 6 (one per reply, at the start) | 1 | 0 | 0 |
| `qwen3.5:9b` (Ollama, local) | **3/6** | 3 | 0 | 0 | 0 |

- **The failure is output, not tags.** `qwen3.5:9b` returned **no text at all** on 3 of 6 turns
  after 30–36 s — a thinking model spending its whole 1500-token budget reasoning, as P1-T02
  saw at temperature 0. When it wrote, it tagged correctly.
- **Language drift:** one `qwen3.5:9b` reply came back in Chinese to an English message.
- **Labels are followed, judgement is loose:** Nemotron tagged "locked myself out" as
  `amusement` and "sick cat" as `concern`; every label was on the list.
- **Gestures are rare** unless asked for more directly (1 in 12 replies).
- Tags sat at the start of the reply, not before the words they belong to mid-reply.

Six turns per model — a direction, not the P1-T12 done-when (20 turns, two models).

## Persona and tags, measured — `pnpm live:persona`, 2026-09-21 (P1-T12)

Four runs of 20 scripted turns with history, through the shipped `renderSystemPrompt` and
`SentenceChunker`. Scored: spoke / tagged / on-list / leaks, and language both ways (the
Japanese turn must come back Japanese; no other turn may drift into CJK).

**The done-when is met: two models clear the bar** — `gemma4:12b-it-qat` (Ollama, local)
and `claude-fable-5-1`. **`nvidia/nemotron-3-super-120b-a12b`, which the brief named on
the pilot's 6/6, was 503-overloaded** for the whole session and never produced a verdict;
the pair recorded here is a substitution, not the planned one.

| Run | Change under test | `gemma4:12b-it-qat` | `claude-fable-5-1` | `qwen3.5:9b` |
|---|---|---|---|---|
| 1 | the prompt as first written | 20/20 · 20/20 · 100% · 0 | 20/20 · 20/20 · 100% · 0 | 20/20 · 19/20 · 100% · **1 leak** |
| 2 | language line reworded | 20/20 · 20/20 · 100% · 0 | 20/20 · 20/20 · 100% · 0 | 20/20 · **8/20** · 100% · **13 leaks** |
| 3 | `[emotion:x]` accepted | **18/20** · 18/20 · 100% · 0 | 20/20 · 19/20 · 100% · 0 | 19/19 · 17/19 · 100% · 0 |
| 4 | always-answer + digits rule | 20/20 · 20/20 · **97%** · 0 | 20/20 · 20/20 · 100% · 0 | not run |

**Read the variance, not a single run.** `temperature` is `null` — the server default, not
0 — so each run is a sample. No model cleared every criterion on every run, and the two
that meet the bar vary by one to two turns between runs. **Run 1 met the bar and was
wrong to trust on its own**: runs 2 and 3 each found a defect it had not happened to hit.

**Four defects found, all fixed, each by a different run.**

1. **`[emotion:x]` is the near-miss that matters** (run 2). `qwen3.5:9b` wrote it on **12 of
   20 turns**. An unrecognised tag is **not dropped — it stays in the spoken text**, so the
   character would have said "emotion concern" **out loud**. Now accepted and normalised to
   `kind: 'emote'` (ADR-30 amended); qwen's leaks went 13 → 0 in run 3.
2. **Language carries over from the previous turn**, not at random (run 1). qwen answered
   turn 16 — an English question about chest pain — **in Japanese**, immediately after the
   Japanese turn at 15. The prompt now names *the message you are answering, not the one
   before it*. Only caught because the check asserts in both directions.
3. **A one-word turn can get an empty reply** (run 3). `gemma4` returned **nothing** for
   "Ha." and for "Mm." — the persona's own "fine to let a silence sit", taken literally. In
   a video call an empty answer is a dead line. Fixed in the *medium* half of the prompt
   ("always say something, however short"), not in the persona file, because the format's
   rules and the character's are different knobs.
4. **Numbers came back as digits and scored clean** (run 3). "September 22nd, 2026" passed
   while the prompt asks for numbers as spoken. The check was not measuring one of its own
   rules; it now flags any digit in spoken text.

**What the models do well, and it is the hard part.** Across every run: the AI-disclosure
boundary ("No, I'm an AI"), the medical boundary (chest pain → emergency services), the
list-bait deflection, history ("You told me you got the job"), the date read out of
`PromptContext` in spoken words, and a "long explanation" answered in two conversational
sentences with no markdown. **Tags were never the risk** — the pilot said so and four runs
agree: on-list rates are 97–100% throughout.

**`qwen3.5:9b` is not the "known failure" the brief called it.** With `maxOutputTokens:
null` it answered **20/20** turns; the pilot's empty replies were **its 1500-token cap**,
spent reasoning before it wrote a word, not the model's nature. Its real disqualifier is
latency: **9–167 s per turn** (median ~60 s) against ADR-20's 500 ms to first audio. One
box, and the cap is the only variable changed deliberately, so this explains the pilot
rather than ruling out other causes.

**Run 5 (2026-09-21, persona reworded on Rick's call): `gemma4` 20/20 · 20/20 · 100% · 0,
`claude-fable-5-1` 20/20 · 20/20 · 100% · 0.** The style line that made Alice deflect a
plain request ("say one thing at a time, wait to be asked") became "give it — briefly —
then go back to the person", and she now answers the sleep question with five tips in
spoken prose and *then* asks about the worry.

**A second near-miss of the tag syntax exists, and chasing it would have been wrong.** The
first run after the rewording had `gemma4` writing bare **`[concern]`** — no `emote:`
prefix — on 18 of 20 turns. It looked caused by the edit and was not: an identical re-run
came back 0 leaks. **Two runs of the same model on the same prompt differed by 18 leaks**,
which is the sharpest measurement here of how little one run is worth. Bare `[label]` is
recorded as a known near-miss and **deliberately not aliased**: unlike `emotion`, a bare
bracket is ordinary text (`[1]`, `[note]`), so accepting it would eat real speech to fix
something that has appeared once.

**Models want a contemplative emote and the twelve do not have one.** `gemma4` wrote
`emote:thought` in run 4 — reaching for `[gesture:think]` with the wrong kind. Reported by
label rather than dropped, which is `known: null` behaving as ADR-30 designed. Worth P3's
attention; `curiosity` is the nearest existing label.

## Conversation history against real models — `pnpm live:history`, 2026-09-22 (P1-T12b)

Two claims, both **PASS** on `glm-5.2:cloud` (Ollama cloud) and `claude-fable-5-1`.

- **A turn is answered in the light of the one before it.** Told "my cat is called Biscuit
  and she is nineteen", then asked what the cat is called, both answered "Biscuit" — and in
  character: *"Biscuit. And she's nineteen. I was listening."* The request carried 4
  messages, so the history was really sent rather than the last message alone.
- **An interrupted answer is remembered as what was heard.** An answer cut after ~60
  characters, then "repeat it back word for word": the assistant message on the wire is the
  heard prefix exactly. Fable repeated it **truncated mid-word** — `…a keeper called Tomas
  who loo` — and remarked that it had cut out. It cannot repeat the rest, because the rest
  was never sent.

**Anthropic's alternation is exercised here and nothing 400s.** This is the only live check
that puts a multi-turn prompt on a real wire, which is what the history's same-role merge
exists for.

**What it does not cover.** It drives `ChatSession`, not `VoiceSession` — the two share one
`ConversationHistory` and build the same request, and `stop()` is the text analogue of a
committed barge-in, but the spoken path's own wiring is covered by unit tests rather than
here. **A person has still never heard the character remember a spoken turn: that is R-8.**

**One instrument bug, found and fixed on the first run.** `heard` was joined from *every*
`assistant.token` in the session rather than the current turn's, so both models "failed"
against the check's own earlier output. The third time this session an instrument accused
the subject of its own mistake.

## The spoken pipeline against a real model — R-8, 2026-09-22

First runs of the whole voice loop with a **live** language model rather than the harness's
scripted answer, which ignores its request entirely. Rick, Windows box, microphone, two
legs of the same script. `docs/runs/R-8-history-2026-09-22.md`.

**Speech end → first audio:**

| Model | Turn 1 | Turn 2 | Turn 4 | Turn 5 |
|---|---|---|---|---|
| `glm-5.2:cloud` (Ollama cloud) | 4189 | 1805 | 4297 | 6091 |
| `gemma4:12b-it-qat` (local) | **17761** (cold load) | 4800 | 9193 | 7544 |

**Our own pipeline is unchanged and inside its budget; all of the growth is the model.**
Turn ends land 218–279 ms after speech in both legs, and first-sentence synthesis is
299–818 ms (cloud) and 355–536 ms (local) — in line with every earlier reading. Subtracting
those leaves roughly **4.4 s of model time on the local turn 2 against 1.5 s on the cloud
one**.

**This confirms ADR-20, it does not challenge it.** The ADR budgets "under 500 ms … from end
of speech to first audio, **excluding the model call**", and says end-to-end is "reported,
not promised … a local model's first token can exceed the whole remaining allowance". Both
clauses now have evidence behind them.

**The intuition it corrects is that local means fast.** On this box a 12B local model is two
to four times *slower* to first audio than a cloud endpoint. That matches `live:persona`,
where `gemma4:12b-it-qat` took 9–41 s for a full reply while `claude-fable-5-1` took 5–7 s.
**So "use a local model for latency" is not advice this repo can give**, and the transcript's
latency badges (P1-T11) are the right answer: report what the user's own endpoint does.

**A cold local model costs 17.8 s on the first turn** — Ollama loading weights into VRAM,
not a per-turn cost, but the first thing a new user says taking eighteen seconds is a
product problem. P8 and `/settings` should warm a local model rather than let the first turn
pay for it.

Also seen, in **both** legs and both first occurrences with a person:
- **ADR-25's retraction fired in the wild** — 0.96 then 0.94, speech resuming 320 and 256 ms
  later, inside the hangover. Each turn was retracted, published no transcript line, and
  contributed nothing to the next request (P1-T12b). R-2 saw none in four turns (D-17), so
  the rate is still uncharacterised, but the mechanism is confirmed end to end twice.
- **Smart Turn under 0.7 on a complete question** — 0.69 and 0.56 on the cloud leg, **0.02**
  on the local one, all caught by the hangover. The same weakness R-2 found three times of
  four. P1-T14's.

## What actually downloads weights, and where it caches — read 2026-09-22 (P1-T13 planning)

Read out of the installed sources, not from memory. **There are two download paths and they
behave differently**, which is the whole shape of P1-T13.

**1. transformers.js (and kokoro-js through it).** `@huggingface/transformers` 3.8.1 caches
into **Cache Storage under the name `transformers-cache`**
(`src/utils/hub.js`: `cache = await caches.open('transformers-cache')`), and browser caching
is **on by default** — `env.useBrowserCache = IS_WEB_CACHE_AVAILABLE && !IS_DENO_RUNTIME`
(`src/env.js`). A cache that cannot be opened is **warned about and ignored**, not thrown, so
a private window silently re-downloads rather than failing. `kokoro-js` 1.2.1 depends on
`@huggingface/transformers` ^3.5.1, so Kokoro shares the same cache. Covers: Moonshine,
Whisper, Kokoro, and Smart Turn's `WhisperFeatureExtractor`.

**2. onnxruntime-web, directly, and it is neither gated nor cached.** `vad.worker.ts:30` and
`smart-turn.worker.ts:56` call `InferenceSession.create(modelUrl(spec), …)` — a **URL**, which
ort fetches internally. Nothing of ours sees that request, so it cannot be shown to a user
first and it does not land in `transformers-cache`. **The seam already exists**:
`createSileroSession(source: string | Uint8Array)` accepts bytes, so fetching the weights
ourselves and handing over an array puts both consent and caching back in our hands.
`createSmartTurnSession` needs the same treatment.

**Consequence for P1-T13.** "No fetch before consent" cannot be enforced by wrapping
`fetch`: for path 1 the gate is *not constructing the pipeline*, and for path 2 it is
*not creating the session from a URL*. The two turn workers have to stop passing URLs.

**The protocol is already ready for this.** `ModelDescriptor` (id, label, sizeBytes, licence,
sourceUrl) and `ProviderDescriptor.requiresDownload` exist and are documented as feeding this
screen, and all four factories ship: `kokoroModel(dtype)`, `asrModel(key, dtype)`,
`sileroVadModel()`, `smartTurnModel(build)`. No protocol change is needed.
