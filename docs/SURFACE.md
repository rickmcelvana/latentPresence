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
