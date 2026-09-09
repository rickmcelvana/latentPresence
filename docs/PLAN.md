# latentPresence — Development Plan (human developers)

This is the base plan a small human team could follow. `docs/LLM-PLAN.md` breaks the same phases into agent-sized tasks. Estimates assume one to two developers and exist only for sequencing; there is no deadline.

Guiding constraints: browser-first, BYO models, nothing shipped, MariaDB as the power store, open-source friendly. Definitions live in `docs/DECISIONS.md`; background in `docs/RESEARCH.md`.

Each phase ends with a demo and a short retrospective note in `docs/SESSION-LOG.md`.

---

## Phase 0 — Foundations and spikes (2–3 weeks)

Goal: a repo that builds, tests and deploys an empty app, plus answers to the four questions that could change the architecture.

Deliverables
- Monorepo per ADR-11 with `pnpm gate` mirroring CI (typecheck, lint, unit tests, web build, cargo fmt, clippy, cargo test).
- Design system: `theme.css` with the teal tokens, primitives, a `/gallery` route, and the className-coverage and no-colour-literal tests in the gate (ADR-15).
- `site/` skeleton for latentpresence.com (landing, docs placeholder, feedback form) and a deploy script for both hosts.
- `packages/protocol`: provider interfaces (`LLMProvider`, `STTProvider`, `TTSProvider`, `EmbeddingProvider`, `MemoryStore`, `AvatarRenderer`, `Schedule`) with zod schemas and capability flags.
- Spike A: in-browser voice loop latency. Silero VAD + Moonshine STT + Kokoro TTS in workers on WebGPU; measure end of speech to first audio.
- Spike B: VRM in react-three-fiber with wawa-lipsync driving mouth shapes from a TTS audio node; measure frame time on integrated GPU.
- Spike C: Rust companion skeleton with a MariaDB 11.8 vector table, insert and cosine search from a TS client, measured over the tunnel to the remote dev database and in CI.
- Spike D (**done 2026-09-08**): Smart Turn v3 in onnxruntime-web. Go — 168 ms on fp32/WebGPU against a 512 ms hangover, no held pause interrupted in the recommended configuration. `docs/spikes/D-smart-turn.md`.
- Spike E: Tauri 2 shell on Windows (WebView2) running spikes A and B, then on Rick's Linux box; macOS deferred.

Exit criteria: spikes documented in `docs/spikes/`, ADR-01 to ADR-07 flipped to accepted or amended.

## Phase 1 — Conversation core (4–6 weeks)

Goal: talk to any LLM by voice or text with natural turn-taking, with a placeholder avatar (audio waveform or static image).

Deliverables
- `packages/core` conversation engine as an explicit state machine: `idle → listening → thinking → speaking → interrupted`, with an event bus.
- Streaming LLM with sentence chunking to streaming TTS; audio queue with barge-in fade and cancellation.
- Turn-taking using VAD plus Smart Turn v3, recognition overlapping turn detection (ADR-21); backchannel scheduler (v1: simple).
- Provider settings UI: OpenAI-compatible base URL and key, Anthropic, NVIDIA, Ollama and LM Studio presets with CORS instructions; STT and TTS choices (browser, server, cloud).
- Text chat panel with transcript, interruptions marked, latency badges.
- Persona v1: system prompt template with name, voice, style; inline tag protocol (`[emote:]`, `[gesture:]`) parsed and stripped.
- Model download consent screen with size and licence (ADR-09).

Exit criteria: five-minute unscripted voice conversation with interruptions, under 1 s to first audio on a mid-range laptop with browser models, and under 600 ms with a local server.

## Phase 2 — Avatar and stage v1 (4–6 weeks)

Goal: the character is on screen, alive, lip-synced, and framed like a video call.

Deliverables
- `packages/avatar` VRM renderer implementing `AvatarRenderer`; loads VRM 1.0 and VRMA; expression mapping (VRM presets plus ARKit passthrough).
- Procedural life: breathing, blinking with saccades, gaze policy (camera, user, look-away when thinking), idle weight shifts.
- Clip library: CC0 idle, listen, talk, gesture clips retargeted to VRM, blended by state.
- Lip sync from wawa-lipsync with optional phoneme timing from TTS.
- Stage v1: simple room, three-point lighting, camera presets (bust, medium, full), user PiP window if camera on.
- Placeholder character: a licensed-for-redistribution VRM until the custom character lands (Phase 7).

Exit criteria: the character listens, thinks and speaks with believable idle motion; no visible pops between states; 60 fps on a mid-range GPU at 1080p.

## Phase 3 — Affect engine and emotion sensing (3–5 weeks)

Goal: body, face, voice and words agree, and the character reacts to the user's emotional state.

Deliverables
- Affect engine (ADR-12): PAD mood with decay, event queue, mapping tables to expressions, gesture bias, gaze policy, TTS hints, and a system-context injection.
- User affect fusion: text heuristics + LLM side-channel, voice SER (emotion2vec+ or wav2vec2 ONNX in a worker), optional camera with MediaPipe blendshapes (explicit opt-in, nothing leaves the device, no frames stored).
- TTS emotion hint mapping per provider; prosody fallback (rate, pauses) for providers without style control.
- Backchannels v2: gated by affect and user prosody; reactive expressions while the user speaks.
- Debug overlay showing mood, events and user affect.

Exit criteria: a test script of emotional turns (joy, frustration, sadness, sarcasm) produces distinguishable, consistent responses across face, body and voice.

## Phase 4 — Memory and MariaDB (4–6 weeks)

Goal: the character remembers across sessions, and plans live in the database.

Deliverables
- Companion: `db` crate with migrations for sessions, turns, embeddings, facts (bi-temporal), self-model blocks, plans, plan items, documents, chunks.
- Memory kernel in `packages/core`: extraction after each turn, retrieval before each turn, consolidation job when idle, forgetting policy, user-visible memory browser with delete.
- `MemoryStore` adapters: `mariadb` (through companion), `indexeddb` (web-only), `sqlite` (desktop).
- Self-model blocks editable by the agent via tools, including mood persistence.
- Planning studio v1: brainstorm mode, structured plan objects, side panel editor, Markdown export, follow-up reminders.

Exit criteria: close the app, reopen a week later, the character references the right facts and the plan you made; retrieval under 100 ms on 50k chunks.

## Phase 5 — Knowledge and tools (4–6 weeks)

Goal: grounded answers from the user's documents and databases, and actions in the world.

Deliverables
- MCP client in the app with a server manager UI; companion hosts first-party MCP servers.
- Document ingestion pipeline (PDF, MD, DOCX, HTML, TXT) with chunking, BYO embeddings, incremental re-index; citations in answers.
- Custom database connector: register a MariaDB, MySQL, Postgres or SQLite source, introspect schema, read-only text-to-SQL with preview and confirm.
- Web search (SearXNG or BYO Brave/Tavily) and Playwright MCP browser tool.
- Home Assistant MCP connection with device confirmation policy.
- Diegetic displays: screen and whiteboard objects in the set that render tool results.

Exit criteria: ask a question answered only by a private PDF and get a cited answer; ask for a fact from a registered database and get a correct query preview; turn on a light.

## Phase 6 — Presence, life and schedules (4–6 weeks)

Goal: the character feels continuous and present rather than request-driven, and can act on your behalf later.

Deliverables
- Idle behaviours in the set (reading, stretching, looking outside) driven by mood and time of day.
- Time awareness: greetings by time, elapsed time since last session, calendar-free reminders from plans.
- Proactive check-ins with strict rate limits and a user-controlled dial.
- Sleep: idle-triggered consolidation with a visible "she's resting" state.
- Inner monologue: private reasoning channel summarised into a peekable panel; never spoken unless asked.
- Multiple characters and personas, each with separate memory namespaces.
- Scheduled tasks (ADR-14): one-shot and recurring jobs the character runs with a tool allowlist, catch-up policies for missed runs, a Schedules panel, spoken confirmation on creation, results delivered at the next session or by notification.

Exit criteria: leave the app open for an hour; the character does something reasonable every few minutes without being annoying (measured by a user-tunable interruption budget). A scheduled reminder set by voice fires on time.

## Phase 7 — Character pipeline and realism (parallel track, 4–8 weeks of art time)

Goal: a semi-realistic custom full-body character and a documented pipeline.

Deliverables
- `docs/pipeline/character.md`: image to mesh to rig (UniRig or Rigify) to ARKit blendshapes to VRM 1.0 export; validation checklist.
- The default latentPresence character with PBR materials and 52 ARKit shapes, plus a stylised alternative.
- Higher-fidelity set with baked lighting and time-of-day variants.
- Optional Audio2Face-3D bridge in the companion for NVIDIA GPUs.
- Experimental LAM head renderer plugin (research spike, not release-blocking).

Exit criteria: the pipeline reproduced by someone other than Rick from the doc alone.

## Phase 8 — Desktop and distribution, Windows first (3–4 weeks)

Goal: one-click Windows install with the companion bundled, and the hosted app reaching local services.

Deliverables
- Tauri 2 app for Windows with the companion as a sidecar; Linux only if Spike E passed; macOS deferred (ADR-07).
- Tray mode that keeps the character alive for schedules and check-ins; optional compact always-on-top presence window.
- Auto-update, crash-safe settings, first-run wizard (choose providers, connect MariaDB or use SQLite, download browser models).
- `app.latentpresence.com` connecting to a local companion, Ollama or LM Studio (pairing, CORS, Chrome Local Network Access).
- Unsigned installers (owner decision, as in latentCreate); reproducible builds in CI; draft GitHub release on tag.

Exit criteria: fresh Windows machine to first conversation in under ten minutes following the README.

## Phase 9 — Polish and 1.0 release (4–6 weeks)

Goal: something you are proud to give away.

Deliverables
- Accessibility (captions, keyboard control, reduced motion), localisation scaffold, performance budgets enforced in CI.
- Security review: secrets storage, companion auth, SQL tool guardrails, MCP permission prompts.
- Documentation site: user guide, provider setup guides, character pipeline, architecture, contributing.
- Model registry with licences; privacy page ("nothing leaves your machine unless you point it somewhere").
- Release: tagged 1.0, GitHub release with installers and web deploy, announcement post.

---

## Cross-cutting rules

- The build loop is architect edits, `pnpm gate`, commit on green (ADR-13). Tests land with the code in the same commit.
- Every component is styled in `theme.css` the day it is written; the gate fails on an unstyled className (ADR-15).
- Every phase adds tests: unit for `core`, integration for companion, Playwright for the voice loop with synthetic audio.
- Every provider gets a fake implementation for tests and demos.
- Performance budgets (ADR-20, amended by ADR-21): voice pipeline under 500 ms from end of speech to first audio **excluding the model call**, and **including turn detection** — measured 553 ms on WebGPU with fp32 once Smart Turn v3 is counted and recognition overlaps it, so 53 ms over and not yet met; end-to-end reported rather than promised, since it depends on the user's LLM. WebGPU is required for synthesis (wasm Kokoro is 3779 ms). 60 fps at 1080p on a mid-range GPU, under 400 MB browser memory without models.
- No telemetry. Ever.
