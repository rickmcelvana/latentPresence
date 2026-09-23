# latentPresence — LLM execution plan

Same phases as `docs/PLAN.md`, broken into tasks an agent can pick up cold. Read `PROJECT.md` first to find the current phase and next task. Do not read this whole file; jump to the current phase.

Task format
- **ID** `P<phase>-T<nn>`. Stable; never renumber. Add new tasks at the end of a phase.
- **Owner** `main` (the architect writes it directly), `sub` (delegated to a subagent the architect runs, to save architect context), or `human` (Rick: art, accounts, server). `aider` appears only on tasks that historically went through that lane; it is retired — `docs/WORKFLOW.md` says why.
  **The split is not about size.** `sub` is for work a competent implementer could get right from the brief and the repo alone. `main` is for work whose correctness depends on a fact that has to be measured, read out of a dependency's source, or decided — because that fact-finding *is* the task, and a brief that contains it has already done it.
- **Depends** task IDs that must be done first.
- **Done when** acceptance criteria; the reviewer checks these, not the prose.
- Status lives only in `PROJECT.md` and the session log, never here.

Conventions for all tasks
- Interfaces in `packages/protocol` change only in `main`-owned tasks.
- Every provider gets a `Fake*` implementation and a unit test. Tests land with the code.
- Every new className gets its rule in `theme.css` in the same commit (ADR-15).
- `pnpm gate` green, then commit with message `P1-T03: <summary>`. Never commit red.

---

## Phase 0 — Foundations and spikes

### P0-T01 Monorepo scaffold — owner: main
Create the layout in ADR-11 with pnpm workspaces, Vite + React 19 + TypeScript strict in `apps/web`, empty packages with `package.json` and `tsconfig` project references, oxlint, Vitest, a cargo workspace in `companion/` with an `axum` hello server, `LICENSE` (Apache-2.0) and `NOTICE`, `.editorconfig`, `.env.example` with `DATABASE_URL`. Root `pnpm gate` chains `tsc -b`, oxlint, vitest, vite build, `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test --workspace`, in CI order; `gate:app` and `gate:rust` run half each. CI workflow on `ubuntu` and `windows` runs the same commands the README gives a contributor.
Done when: `pnpm install && pnpm gate` succeeds from a clean clone on Windows; CI green.

### P0-T02 Protocol package — owner: main
`packages/protocol`: zod schemas and TS types for `LLMProvider`, `STTProvider`, `TTSProvider`, `EmbeddingProvider`, `OmniProvider`, `MemoryStore`, `AvatarRenderer`, `AffectState`, `UserAffect`, `ConversationEvent`, `ToolCall`, `Schedule`, plus capability flag objects. Companion HTTP/WS API schema (`/health`, `/db/*`, `/ingest/*`, `/mcp/*`, `/schedules/*`) as zod.
Done when: package builds, exports documented in its README, one test per schema round-trips a sample.

### P0-T02b Design system — owner: main
`apps/web/src/theme.css` with the ADR-15 tokens (latentbeats base, teal accent, `--on-accent`), base typography, scrollbar treatment, button, panel, input, pill and drawer primitives, focus-visible rings. Port `theme.test.ts` from latentCreate (className coverage, computed prefixes, stale exemptions) and add a test that no colour literal (`#`, `rgb(`, `hsl(`) appears outside `:root`. A `/gallery` dev route renders every primitive in every state for click-through and later Playwright screenshots.
Done when: both tests green in the gate; Rick's click-through of `/gallery` passes; tokens documented at the top of `theme.css`.

### P0-T03 Site skeleton and deploy script — owner: aider (done; that lane is retired)
`site/` static pages in the latentbeats.com structure: `index.html` (landing with the same sections: hero, story, features, how it works, privacy, footer), `docs/index.html` (placeholder), `feedback/index.html` + `feedback.js` (posting to `/api/feedback` with `source: "presence"`), `css/style.css` with the ADR-15 tokens, favicons, `site.webmanifest`, `robots.txt`, `sitemap.xml`. `scripts/deploy.sh` syncs `site/` and `apps/web/dist` to the server paths Rick specifies (rsync over SSH, dry-run flag). No GitHub Pages.
Done when: the site renders locally with no unstyled element; the feedback form's payload matches the API's expected shape; deploy dry-run lists the right files. Live feedback needs Rick's backlog item (source whitelist + Caddy).

### P0-T04 Spike A: browser voice loop latency — owner: main
Worker-hosted Silero VAD (onnxruntime-web), Moonshine tiny STT (transformers.js, WebGPU with WASM fallback), Kokoro TTS (kokoro-js). Wire mic to VAD to STT to echo text to TTS. Measure and log end-of-speech to first-audio.
Done when: `docs/spikes/A-voice-loop.md` records numbers on Rick's machine for WebGPU and WASM, memory use, and a go/no-go note.

### P0-T05 Spike B: VRM + lip sync — owner: main
react-three-fiber scene loading a CC-licensed VRM 1.0 sample, wawa-lipsync driving `aa/ih/ou/ee/oh` from an `<audio>` node, one VRMA idle clip.
Done when: `docs/spikes/B-vrm-lipsync.md` records fps on integrated and discrete GPU, and a screenshot.

### P0-T06 Spike C: companion + MariaDB vector — owner: main
Rust `companion` with sqlx (mysql), migration creating `chunks(id, doc_id, text, embedding VECTOR(768), VECTOR INDEX)`, endpoints to insert and to query top-k by `VEC_DISTANCE_COSINE`. TS client in `packages/protocol` tests against the remote MariaDB over the tunnel (`DATABASE_URL` from `.env`) and, for CI, a MariaDB 11.8 service container (compose file in `companion/dev/`). Measure tunnel RTT separately from query time.
Done when: `docs/spikes/C-mariadb-vector.md` records RTT, insert and query latency at 10k and 100k rows over the tunnel and in CI, and states whether the per-turn retrieval budget (100 ms) holds remotely.

### P0-T07 Spike D: Smart Turn v3 in browser — owner: main
Load the ONNX model with onnxruntime-web in a worker, feed 8 s windows from VAD, log probabilities and inference time.
Done when: `docs/spikes/D-smart-turn.md` says pass or fail with numbers; if fail, documents the adaptive silence design.

### P0-T08 Spike E: Tauri shell — owner: main
`apps/desktop` Tauri 2 project pointing at the `apps/web` dev server; run spikes A and B inside it on Windows (WebView2), then on Rick's Linux box (WebKitGTK). macOS not tested (no hardware, deferred by ADR-07).
Done when: `docs/spikes/E-tauri.md` lists what worked (mic, AudioWorklet, WebGPU, WebGL, tray, notifications) per OS, and states whether Linux ships via Tauri or via "companion + Chrome".

### P0-T09 Phase 0 retrospective — owner: main
Check each spike write-up against ADR-01..07 and amend any the spikes invalidated (Linux shell, Smart Turn in browser, tunnel latency budget); update `PROJECT.md` to Phase 1.
Done when: every spike doc is linked from `docs/DECISIONS.md`, and no ADR contradicts a measured result.

---

## Phase 1 — Conversation core

### P1-T01 Conversation state machine — owner: main (done; eb52a01)
`packages/core/conversation`: explicit states `idle | listening | thinking | speaking | interrupted`, typed event bus, transition table, timers. No DOM, no audio APIs; ports for `AudioIn`, `AudioOut`, providers.
Done when: unit tests cover every transition including barge-in during `thinking` and during `speaking`.

### P1-T02 OpenAI-compatible LLM provider and model discovery — owner: main (done; 1318da9, live-verified across nine endpoints in D-2)
`packages/providers/llm/openai-compatible.ts` using AI SDK with base URL, key, model, headers. Presets: Ollama, LM Studio, vLLM, llama.cpp, OpenRouter, NVIDIA (`https://integrate.api.nvidia.com/v1`), DeepSeek, Kimi. Model discovery ported from latentCreate `crates/llm-bridge` (`ollama.rs`, `docs/LLM-SURFACE.md`): Ollama `/api/tags` capabilities (`completion`, `thinking`, cloud), context length, LM Studio listing, `/v1/models` fallback; embedding models excluded from the chat picker. Verified shapes recorded in `docs/SURFACE.md`.
Done when: streaming text and tool calls work against Ollama and NVIDIA in a manual test; the picker hides embedding models and flags thinking models; `FakeLLMProvider` replays a scripted stream; fixtures captured from a live Ollama.

### P1-T03 Anthropic and Google native providers — owner: aider (done; that lane is retired)
Depends: P1-T02. Same interface, native adapters, prompt caching flag for Anthropic.
Done when: streaming works against both with a BYO key; capability flags reported.

### P1-T04 Sentence chunker — owner: aider (done; that lane is retired)
Stream tokens to sentence-or-clause chunks suited for TTS (handles abbreviations, numbers, code, emoji, inline tags). Strips `[emote:]` and `[gesture:]` tags into events with character offsets.
Done when: table-driven tests over 40 tricky inputs pass.

### P1-T05 TTS providers — owner: main (done; the plan said aider and the reference was already verified)
`kokoro-browser` (worker), `openai-compatible-tts` (server or cloud `/audio/speech`), `FakeTTSProvider`. `kokoro-browser` requires WebGPU (3779 ms on wasm against 245 ms on WebGPU); without it the user is steered to a server endpoint. Build the `TextSplitterStream` and close it rather than passing a string to `stream()`, which never returns (Spike A, `docs/SURFACE.md`). Interface supports streaming chunks and optional word timestamps and emotion hints.
Done when: both real providers play audio in the app; capability flags correct.

### P1-T06 STT providers — owner: main (done; the plan said aider and the facts had to be established first)
`moonshine-browser` (worker), `whisper-browser`, `openai-compatible-stt` (`/audio/transcriptions`), `FakeSTTProvider`. `dtype` is set explicitly and q8 is never offered on WebGPU: it returns the same fluent nonsense for every utterance, with no error (Spike A, ADR-20). Recognition starts on the candidate window, in parallel with turn detection, and is discarded if the turn turns out not to be over (ADR-21) — so a provider must tolerate being cancelled mid-transcription.
Done when: live transcription visible in the transcript panel with both a browser model and a server, and a cancelled recognition leaves no partial text in the transcript.

### P1-T07 VAD and turn detection — owner: main (done 2026-09-13; recorded audio replaced by `pnpm live:turn`, and ADR-25 added)
Depends: P0-T07. Silero VAD worker plus a **Smart Turn v3 worker** — adaptive silence is no longer the fallback, Spike D decided it (ADR-21). fp32 build on WebGPU, 100 ms candidate silence, 0.7 threshold; int8 is the no-GPU fallback and must never be offered on WebGPU, where it does not load. The 500 ms hangover stays as the backstop, and an answer arriving after it is reported as late rather than as a miss. Exposes `speechStart`, `speechEnd`, `turnEnd(probability)`.
Done when: tests with recorded audio fixtures detect turn ends within 300 ms of the labelled point, and the candidate window is handed to recognition (P1-T06) at the same moment it is handed to the endpointer — ADR-21's overlap, without which the pipeline is 40 ms over budget on its own.

### P1-T08 Audio output queue and barge-in — owner: main (done 2026-09-13; two-stage barge-in ADR-26, edge trim ADR-27, by-ear check is R-2)
Depends: P1-T01. AudioWorklet playback queue; on user speech start, fade out in 100 ms, cancel LLM stream, mark transcript with the spoken prefix.
Done when: manual test shows no audio clicks and the transcript reflects only the words that were heard.

### P1-T09 Backchannel scheduler v1 — owner: main (done 2026-09-13; words, duck-and-finish ADR-28, by-ear check was R-4)
Depends: P1-T05. Pre-synthesise a small set of backchannels per voice; play in user pauses that are below turn-end probability; simple rate limit.
Done when: plays at most once per 8 s and never over user speech.

### P1-T10 Settings UI — owner: sub (done 2026-09-14; main measured reachability and built the companion relay, ADR-29; a subagent built the page; the new-user check is R-5)
Provider pickers with presets, key storage (WebCrypto-encrypted in localStorage; OS keychain later via Tauri), CORS help text per backend, test-connection buttons.
Done when: a new user can configure Ollama and NVIDIA without reading docs.

### P1-T11 Transcript panel and text chat — owner: sub (done 2026-09-14; main added token events, confirmed-only words and ChatSession; a subagent built the reducer, panel and /chat; by-hand checks are R-6)
Depends: P1-T01. Chat panel with streaming, interruption markers, latency badges (turn end to first token, to first audio), copy and clear.
Done when: matches the design notes in `docs/ui/transcript.md` (main writes this note first).

### P1-T12 Persona v1 and tag protocol — owner: main (done 2026-09-21; ADR-23 closed by promotion, ADR-30 added and amended on the run)
System prompt template (name, voice, style, boundaries, tag protocol description), persona file format (`*.persona.json`), default persona.
Done when: the LLM reliably emits tags in a 20-turn scripted test with two different models. **Met** by `pnpm live:persona`: `gemma4:12b-it-qat` and `claude-fable-5-1` both 20/20 spoke, 20/20 tagged, ≥ 97% on-list, 0 leaks. NVIDIA's Nemotron — the model the brief named — was 503 throughout and never gave a verdict, so the pair is a substitution. Four runs, because the first met the bar and three later ones each found a defect it had not hit; the variance and the four defects are in `docs/SURFACE.md`.

### P1-T12b Conversation history, shared by text and voice — owner: main (done 2026-09-22; history is a projection of the transcript, not a second reducer)
Depends: P1-T11. Found by R-6 (2026-09-21) and placed here by Rick: `ChatSession` keeps the
conversation and, on Stop, remembers the answer as **what the user heard** rather than what the
model meant to say; the spoken path has no equivalent, because `VoiceSession.respond` is a
caller-supplied callback. One `ConversationHistory` in core that both write to, owning the
heard-not-meant rule (an interrupted reply is recorded as its `spokenPrefix`, an abandoned one
not at all), a turn cap, and the `system` slot `renderSystemPrompt` fills. **Before P1-T13**, so
voice never ships without it and P4 inherits the rule rather than rediscovering it.
Done when: a spoken turn answers in the light of the previous one, proven in `/dev/voice` with a
real model and not the scripted one, and a barge-in followed by "what did you just say?" gets
back only the words that were heard. **Met in substance by `pnpm live:history`**: `glm-5.2:cloud`
and `claude-fable-5-1` both recall a fact from the previous turn and, asked to repeat a cut-off
answer word for word, give back exactly the heard prefix — Fable reproduced it truncated
mid-word and said so. **The `/dev/voice` leg is R-8**: the harness now has a `Live model`
switch, but its 473 MB of browser models are not cached in the Claude Browser pane and the
spoken path has not been heard doing this by a person.

### P1-T13 Model download consent — owner: sub (done 2026-09-22; the gate is structural, and the ungated worker factories are withheld from their barrels so bypassing it is a compile error)
Consent modal listing model, size, licence, source URL before any browser model download; cache in Cache Storage; a settings page to delete caches.
Done when: no network fetch of weights occurs before consent (verified in Playwright by intercepting requests). **Met, but not in Playwright — deliberately.** The repo has none, and adding it for one assertion was not worth a browser download and CI changes when **P1-T14 is already a Playwright task**. Proven instead by a structural test: for each of the four worker entry points, no consent throws before `create*Worker` or `fetch` is touched. **The browser leg is owed and belongs to P1-T14.** Note that a `fetch` wrapper could never have proven this — onnxruntime-web fetched weights internally from a URL, which is the thing that changed.

### P1-T14 Phase 1 end-to-end test — owner: main (done 2026-09-22; Playwright against a new dev-only `/dev/e2e`, and it pays P1-T13's browser debt)
Playwright test feeding synthetic audio through a virtual mic, `FakeLLMProvider` and `FakeTTSProvider`, asserting the state machine sequence and a barge-in.
Done when: test runs in CI under 2 minutes. **Met: 8.2 s.** Real `getUserMedia`, capture and playback worklets, Silero as wasm, `TurnDetector`, the machine, `Reply` and `BargeInGate`; the model, the voice and recognition are fakes, so CI needs no WebGPU and fetches only Silero's 2.2 MB. **Chrome's built-in fake audio device drives Silero but fires once at the start of the stream** (measured over 30 s), which is a turn and never a barge-in — so the microphone is fed a committed fixture of two utterances, looped. Its own CI job rather than `pnpm gate`, on the `vector` job's precedent.

### P1-T15 Voice in the product — owner: main (done 2026-09-22; voice is a button on `/chat`, the Voice and Hearing choices build real providers, and the guard's voice needles came out)
Depends: P1-T13. **Found when Phase 1's tasks were all done and its exit criteria were not.**
Every piece of the voice pipeline ships and is measured, and **none of it is reachable by a
user**: `/dev/voice` is a dev-only harness dropped from production builds, `/chat` is typed
only, and `/settings`'s Voice and Hearing sections choose providers nothing instantiates.
Put the pipeline behind a real route, using the consent screen P1-T13 already built, and make
the Voice and Hearing choices do something. The stage and the call framing are P2; this is
the audio loop reaching a person without a dev server.
Done when: a user who has never opened a dev route can hold a spoken conversation from a
production build, and `/dev/voice`'s guard needles (`onnxruntime`, `kokoro-js`,
`@huggingface/transformers`, the two worklet names) can come out of `apps/web/vite.config.ts`
because the pipeline is meant to be in the bundle. **Met as far as a machine can take it.**
Voice is a panel on `/chat` — a lazy chunk behind a *Start voice* button, over P1-T12b's one
machine and one history, so a typed message and a spoken turn are one conversation — and
`apps/web/src/voice/providers.ts` is now the only place the two `/settings` selects become
providers: Kokoro or an OpenAI-compatible server, Moonshine, Whisper or a server, with the
turn models always browser ones because neither has a server counterpart here. The consent
list is derived from the same settings (`browserModelsFor`) so the screen cannot ask for
something the call will not build. **`kokoroSupport` — written in P1-T05 for "the settings UI
steers on it" and called by nothing since — is now wired**, so a browser without WebGPU is
refused in a sentence instead of dying inside onnxruntime; it is checked whichever Voice and
Hearing sources are chosen, because Smart Turn's `gpu` build is the only one wired and Spike
D's int8 `cpu` fallback is not. **The guard was rewritten rather than deleted**: the five
voice needles are expected in a bundle now, so they were replaced by `voiceHarness` and
`e2eHandle` — names only the two dev pages write — and both were mutation-checked (removing
`import.meta.env.DEV` from either route fails the build). The production build emits the
workers and the 21.6 MB onnxruntime wasm (`docs/SURFACE.md`). **The half a machine cannot
verify is R-9**: nobody has yet held the five-minute conversation from a production build.

---

## Phase 2 — Avatar and stage v1

### P2-T01 AvatarRenderer VRM implementation — owner: main (done 2026-09-22; `VrmAvatarRenderer` at `@latentpresence/avatar/vrm`, debug panel at `/dev/avatar`)
`packages/avatar/vrm`: load VRM 1.0 and VRMA, implement `AvatarRenderer`, expression mapping table (VRM presets and ARKit passthrough), look-at target.
Done when: sample VRM shows all presets via a debug panel; interface tests pass against a `FakeAvatarRenderer`. **Met.** `/dev/avatar` cycles the six presets on the placeholder and shows what each of the fourteen protocol names resolved to on that model; checked in the Browser pane with `surprised`, `angry`, the `mouthSmile` → half-`happy` fallback, `aa`, two gaze targets and a one-shot VRMA resolving on its own end. The fake, the clip player (a real `AnimationMixer`) and the face driver (a real `VRMExpressionManager`) are tested in node. **Two rules the later tasks inherit:** a viseme is its own channel and keeps its weight until set again, with `sil` closing all five — so P2-T04 can blend as Spike B did; and `playClip` resolves a one-shot when it ends *or is replaced*. The build guard's `three-vrm` needle stays until a production route mounts the renderer (P2-T06).

### P2-T02 Procedural life layer — owner: main (done 2026-09-22; `LifeLayer` in `packages/avatar/src/life`; R-10 passed, params unchanged)
Breathing (chest and shoulders), blink with saccades and rate tied to state, gaze policy with drift and return, micro weight shifts. All parameterised.
Done when: with no clips playing, the character does not look frozen in a 60 s recording reviewed by Rick. **Met by R-10 (D-23): "No frozen time. Not too much blinking. Looks good."** — `/dev/avatar`'s Life panel records the minute (canvas to a local webm). Every rate is tested in node against seeded time (blinks at the mean asked for, a listener on the user > 75% of the time and a speaker less, no look away longer than 1.6× its mean, no frame-to-frame jump over 0.02 rad); the sign conventions were checked in the Browser pane. **Two things P2-T03 inherits:** the rest pose stands down whenever a clip is posing the body, so a clip that leaves the arms out leaves them in T-pose; and a VRMA look-at track will fight the gaze policy for the eyes.

### P2-T03 Clip library and retarget — owner: human + sub
Rick selects CC0 clips (Quaternius); Aider adds the retarget script (Blender headless or Mesh2Motion export) and the runtime blend graph (idle, listen, talk, gesture channels with crossfades).
Done when: `assets/clips/` has a manifest with licences; state changes crossfade under 300 ms without pops.

### P2-T04 Lip sync — owner: sub → main (done 2026-09-22; `LipSync` in `packages/avatar/src/lipsync`; R-11 passed)
wawa-lipsync on the output audio node into visemes; if the TTS provides word or phoneme timing, drive from timing instead; jaw and lip smoothing.
Done when: side-by-side video with Kokoro shows sync error under 80 ms. **Met by R-11 (D-24): Rick's eye, and his two recordings measured frame by frame — the mouth is ~50–60 ms behind the sound on both Kokoro recordings (analysis 40–50, display ~10), under the 80 ms bar.** **Kept by the architect rather than delegated**, by CLAUDE.md's rule: every setting that makes it work came from a measurement — wawa-lipsync cannot attach to our output node at all (so its classifier is ported, MIT, held to the original by a 6000-frame golden test), its defaults hold the mouth open 153 ms past a word, and the floor that fixes the rest was read off Kokoro speech. **Measured offline on Kokoro: opens a median 15 ms after speech, shuts 55 ms after, best-fit lag 35 ms** — inside 80 before output and display latency, which pull in opposite directions. The timing path (`visemeAt`, `LipSync.useTimings`) exists for a TTS that reports words; none does, and `PlaybackSegment` carries none, so wiring it through `Reply` waits for one that does.

### P2-T05 Stage v1 — owner: sub (built 2026-09-22 by a Sonnet subagent from `docs/briefs/P2-T05.md`; the readings are R-13)
Room with floor, wall, window, desk; three-point lighting; camera presets (bust, medium, full) with smooth transitions; post-processing off by default.
Done when: 60 fps at 1080p on Rick's machine and 30 fps on an integrated GPU. **Desktop half met 2026-09-23 (R-13): 120.5 fps median, 119.0 at the 5th percentile, worst frame 8.5 ms at 1920×1078, shadows on or off — twice the bar, and the same median as Spike B's bare avatar. The integrated-GPU half waits for the laptop** (with R-1/R-9). `buildStage` (primitives only — nothing fetched), key/fill/rim + hemisphere with the key the only caster, `CameraRig` easing between `face`/`bust`/`medium`/`full` from wherever it is, and a Stage panel on `/dev/avatar` with a 1080p render scale and a `FrameRecorder` reading. **Review changed three things, each seen in the Browser pane**: framing used the VRM `head` bone as the crown and cropped the hair (it sits at the base of the skull — now the model's bounding box, the eye bones for height, medium/full level, the distance solved with the tilt in it, and a test that measures real view angles rather than the one that passed while cropping); shadows `off` kept drawing the last shadow map until materials were flagged for recompile; the window clipped to flat white.

### P2-T06 Video-call layout and user PiP — owner: sub
Layout: character full frame, transcript drawer, controls bar (mute, cam, text), user camera PiP when enabled (no processing yet).
Done when: responsive from 1024 px to 4K.

### P2-T07 Tag to animation bridge — owner: main
Depends: P1-T04, P2-T01. `[emote:]` and `[gesture:]` events scheduled at their audio time offsets; mapping tables in `packages/avatar/mappings/`.
Done when: a scripted response with five tags fires each within 100 ms of its word.

---

## Phase 3 — Affect engine and emotion sensing

### P3-T01 Affect engine core — owner: main
`packages/core/affect`: PAD mood with configurable decay, event queue, energy, stance; pure functions with fixed timestep; serialisation for persistence.
Done when: property tests confirm bounded state and decay to baseline; documented in `docs/affect.md`.

### P3-T02 Affect to expression and gesture mapping — owner: sub
Depends: P3-T01, P2-T07. Tables from affect regions to expression weights, gesture bias, gaze policy, idle clip selection.
Done when: the debug overlay shows the mapping live; Rick signs off on a 10-state review.

### P3-T03 Affect to voice and wording — owner: main
Depends: P3-T01. TTS hint mapping per provider; prosody fallback (rate, pause length); system-context injection of a two-line feeling summary and response-length bias.
Done when: the same prompt with two moods yields audibly and textually different responses.

### P3-T04 User affect from text — owner: main
Heuristic scorer (emoji, punctuation, caps, message pace) plus an LLM side-channel field in structured output.
Done when: unit tests over a labelled set of 100 messages reach agreed thresholds.

### P3-T05 User affect from voice — owner: main
SER worker (emotion2vec+ ONNX export or wav2vec2 SER ONNX) on user speech segments; outputs valence, arousal, label, confidence.
Done when: inference under 150 ms per segment in a worker; documented model licence.

### P3-T06 User affect from face (opt-in) — owner: main
MediaPipe Face Landmarker in a worker on the user camera; blendshapes to valence/arousal heuristics; explicit consent; no frames stored; indicator light while active.
Done when: Playwright verifies no camera access before consent; heuristics documented.

### P3-T07 Affect fusion and injection — owner: main
Depends: P3-T04..06. Fuse channels with confidence weighting into `UserAffect`; feed affect engine and LLM context.
Done when: the debug overlay shows fused state; a recorded session reproduces deterministically.

### P3-T08 Reactive listening — owner: main
Depends: P3-T07, P1-T09. Expressions and backchannels during user speech keyed to user affect and prosody.
Done when: reviewer cannot spot a reaction that contradicts the user's tone in a 5-minute test.

---

## Phase 4 — Memory and MariaDB

### P4-T01 Companion db crate and migrations — owner: main
Tables: `sessions`, `turns`, `turn_embeddings`, `facts` (subject, predicate, object, valid_from, valid_to, confidence, source_turn), `self_blocks`, `plans`, `plan_items`, `documents`, `chunks`, `model_registry`. Vector columns with dimension per collection; HNSW indexes.
Done when: migrations apply on MariaDB 11.8; sqlx offline checks pass in CI.

### P4-T02 Companion memory API — owner: sub
Depends: P4-T01. REST and WS endpoints for turns, facts (with supersede), self blocks, plans, search (hybrid: vector plus keyword).
Done when: OpenAPI generated from the zod schema matches; integration tests pass in CI with a MariaDB service container.

### P4-T03 Memory kernel — owner: main
`packages/core/memory`: extract facts after a turn (LLM structured output), retrieve before a turn (hybrid search, recency, importance), consolidation job, forgetting policy, memory namespaces per character.
Done when: unit tests with `FakeMemoryStore`; a replay of 30 turns yields the expected fact set.

### P4-T04 MemoryStore adapters — owner: sub
Depends: P4-T02. `mariadb` (companion client), `indexeddb` (web-only, brute-force cosine), `sqlite` (desktop later; stub now).
Done when: the adapter conformance test suite passes for both implemented stores.

### P4-T05 Memory browser UI — owner: sub
List, search, edit, delete facts and turns; show what was injected into the last prompt.
Done when: deleting a fact removes it from the next retrieval.

### P4-T06 Self-model blocks and mood persistence — owner: main
Depends: P3-T01, P4-T03. Agent tools `self.read_block`, `self.write_block`; mood snapshot on session end and load on start with elapsed-time decay.
Done when: mood carries across a restart in a scripted test.

### P4-T07 Planning studio v1 — owner: main
Brainstorm mode prompt, `plan.create/update/list` tools, plan schema, side panel editor, Markdown export, follow-up scheduling stored as facts.
Done when: "let's plan a vegetable garden" ends with a saved plan visible in the panel and in MariaDB.

---

## Phase 5 — Knowledge and tools

### P5-T01 MCP client and server manager — owner: main
AI SDK MCP client; UI to add servers (stdio via companion, HTTP, SSE); per-tool permission policy (auto, ask, never).
Done when: a public demo MCP server's tools are callable with an "ask" prompt.

### P5-T02 Companion MCP host — owner: main
Depends: P5-T01, P4-T02. Companion exposes first-party MCP servers: memory, plans, documents, sql, files (scoped roots).
Done when: tools listed and callable from the app; permission prompts appear.

### P5-T03 Document ingestion — owner: sub
Depends: P4-T01. Rust extractors (PDF, MD, DOCX, HTML, TXT), chunker with overlap, BYO embeddings call, incremental re-index by content hash, watch folders.
Done when: 1,000-page PDF set indexes without errors; re-running is a no-op.

### P5-T04 Cited answers — owner: main
Depends: P5-T03. Retrieval tool returning chunks with ids; prompt policy for citations; citation renderer in transcript and on the in-world screen.
Done when: answers to five private-document questions cite the right chunk.

### P5-T05 Custom database connector — owner: main
Register MariaDB, MySQL, Postgres, SQLite sources; schema introspection with sampling; read-only text-to-SQL tool with preview and confirm; row and time limits.
Done when: SQL injection test-suite passes; no write statement can execute.

### P5-T06 Web search and browser tools — owner: main
SearXNG provider, Brave and Tavily BYO providers, Playwright MCP wiring, result rendering on the in-world screen.
Done when: "what's the weather" answers with a cited source.

### P5-T07 Home Assistant — owner: main
Connect to HA's MCP server with a long-lived token; device confirmation policy; area-aware prompts.
Done when: a light toggles from voice with a confirm step; policy can set specific devices to auto.

### P5-T08 Diegetic displays — owner: sub
Depends: P2-T05. Screen and whiteboard objects rendering HTML-to-texture or canvas textures for tool results and plans.
Done when: a plan appears on the whiteboard and a search result on the screen with readable text at the medium camera preset.

---

## Phase 6 — Presence, life and schedules

### P6-T01 Idle behaviour planner — owner: main
Behaviour tree or utility system selecting idle activities by mood, time of day and elapsed idle time; hooks into clips and set props.
Done when: an hour-long idle log shows varied, plausible activity with no repeats within 10 minutes.

### P6-T02 Time awareness — owner: main
Greeting by time, elapsed-time phrasing, "last time we" openers from memory, plan follow-ups.
Done when: reopening after a simulated week yields correct phrasing.

### P6-T03 Proactive check-ins — owner: main
Rate-limited initiative with a user dial (off, rare, normal), grounded in memory and plans, never during user speech.
Done when: budget never exceeded in a 24 h simulated run.

### P6-T04 Sleep and consolidation — owner: main
Depends: P4-T03. Idle-triggered consolidation with a visible resting state; wake on user activity.
Done when: fact count grows sublinearly over a long transcript replay; duplicates merge.

### P6-T05 Inner monologue — owner: main
Private reasoning channel (model thinking or a separate short call) summarised into a peekable panel; never spoken.
Done when: toggling the panel shows current private notes; TTS never includes them.

### P6-T06 Multi-character — owner: sub
Character packs (VRM, persona, voice, memory namespace); switcher; per-character settings.
Done when: two characters keep separate memories in one database.

### P6-T07 Scheduler core — owner: main
Depends: P4-T03. `packages/core/scheduler` per ADR-14: `Schedule` model (cron or one-shot, task prompt, allowed tools, delivery mode, catch-up policy), a tick loop with a fixed timestep, missed-run reconciliation on wake, execution through the normal agent loop with the schedule's tool allowlist, results stored as memory episodes. Companion endpoints `/schedules/*` and a `schedules` table; companion-side execution for tool-only jobs.
Done when: unit tests cover cron parsing, next-run computation across DST, each catch-up policy, and delivery routing; a simulated week replays deterministically.

### P6-T08 Schedule tools and panel — owner: sub
Depends: P6-T07. Agent tools `schedule.create`, `schedule.list`, `schedule.cancel`, `schedule.run_now`; natural-language time parsing with the character reading back the interpreted time before confirming; Schedules panel listing upcoming runs, last results, pause and cancel; OS notification delivery in the desktop app.
Done when: "remind me Thursday at 9 to call the vet" creates a schedule the panel shows with the right next run, and the reminder is spoken at the next session after it fires.

---

## Phase 7 — Character pipeline and realism (parallel)

### P7-T01 Pipeline doc and concept art — owner: main + human
The architect generates Alice's concept sheet and turnaround (front, side, back, face close-ups, neutral expression, T-pose or A-pose) through comfy-mcp during a session, iterating with Rick. Then `docs/pipeline/character.md`: exact steps from the approved images to VRM 1.0 (tool, version, settings, export options, validation) for mesh generation, UniRig or Rigify rigging, ARKit blendshapes, VRM export and expression mapping, written so Rick can follow it without asking.
Done when: Rick approves the concept sheet; Rick follows the doc without needing to ask a question, or every question asked is folded back into the doc.

### P7-T02 Default character: Alice — owner: human
Semi-realistic full-body VRM with PBR materials, 52 ARKit shapes, VRM expression mapping; plus a stylised alternative.
Done when: passes the validation checklist; loads in P2-T01 with all expressions.

### P7-T03 Set v2 — owner: human + sub
Baked lighting, time-of-day variants, props with hooks for idle behaviours.
Done when: budget held (60 fps at 1080p).

### P7-T04 Audio2Face-3D bridge (optional) — owner: main
Companion module streaming TTS audio to Audio2Face-3D SDK and returning blendshape frames over WS; renderer consumes ARKit passthrough.
Done when: works on an NVIDIA GPU; documented as optional with licence notes.

### P7-T05 LAM head renderer spike — owner: main
Implement `AvatarRenderer` over the LAM WebGL SDK; head-only mode.
Done when: `docs/spikes/F-lam.md` records feasibility and licence status.

---

## Phase 8 — Desktop and distribution

### P8-T01 Tauri app with companion sidecar (Windows) — owner: main
Bundle companion as a sidecar; local pairing token; window management; OS keychain for secrets; NSIS installer.
Done when: fresh Windows VM installs and talks in under 10 minutes.

### P8-T02 First-run wizard — owner: sub
Provider choice, MariaDB or SQLite choice, browser model consent, mic and camera permissions, character choice.
Done when: no step requires the docs.

### P8-T03 Hosted app to local services — owner: main
`app.latentpresence.com` reaching the companion, Ollama and LM Studio on `localhost`: pairing code, CORS allowlist, Chrome Local Network Access preflight (`Access-Control-Allow-Private-Network: true`) and its permission prompt, onboarding copy per backend, Firefox behaviour verified. Facts recorded in `docs/SURFACE.md`.
Done when: the deployed app talks to a local companion and a local Ollama from Chrome and Firefox after the prompts; a fresh user can follow the on-screen copy.

### P8-T04 Auto-update and CI releases — owner: main
Tauri updater, unsigned artifacts (owner decision as in latentCreate; SmartScreen will warn), release workflow on `v*` tags producing a draft GitHub release; Linux AppImage only if Spike E passed.
Done when: an update installs from a test channel.

### P8-T05 Tray mode: background presence — owner: main
Depends: P6-T07. Close-to-tray keeps the core alive for schedules and check-ins; a compact always-on-top "presence" window option; OS notifications; explicit "quit" ends everything.
Done when: a schedule fires with the main window closed and the notification appears; memory use in tray mode under 300 MB with browser models unloaded.

---

## Phase 9 — Polish and 1.0

### P9-T01 Accessibility and reduced motion — owner: sub
### P9-T02 Performance budgets in CI — owner: main
### P9-T03 Security review — owner: main
### P9-T04 Docs in `site/docs/` (user guide, provider setup, privacy) — owner: sub
### P9-T05 Model registry and privacy page — owner: main
### P9-T06 Release 1.0 — owner: main + human
Done when: tagged release, installers, web deploy, announcement, and `PROJECT.md` reset for post-1.0 planning.
