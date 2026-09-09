# Decisions (ADR log)

One entry per decision. `proposed` until Rick confirms, then `accepted`. Superseded entries stay, marked `superseded by ADR-xx`. Reasoning lives in `docs/RESEARCH.md`; this file records the call.

| ID | Decision | Status | Date |
|---|---|---|---|
| ADR-01 | Browser-first; desktop and web share one frontend | accepted | 2026-09-07 |
| ADR-02 | TypeScript core + Rust companion; no Python in the core | accepted | 2026-09-07 |
| ADR-03 | Full-body semi-realistic VRM 1.0 avatar in three.js behind a renderer plugin interface | accepted | 2026-09-07 |
| ADR-04 | Vercel AI SDK as LLM and tool harness; MCP for tools | accepted | 2026-09-07 |
| ADR-05 | TS memory kernel with `MemoryStore` adapters; MariaDB 11.8 Vector primary, SQLite and IndexedDB fallbacks | accepted | 2026-09-07 |
| ADR-06 | Cascaded voice pipeline by default; omni models optional | accepted | 2026-09-07 |
| ADR-07 | Desktop shell: Tauri 2, **Windows first**; Linux on Rick's box in Phase 0; macOS deferred; Electron is the fallback | accepted (amended) | 2026-09-07 |
| ADR-08 | Smart home via Home Assistant MCP only | accepted | 2026-09-07 |
| ADR-09 | No models shipped; runtime download with consent and licence display, or BYO endpoints | accepted | 2026-09-07 |
| ADR-10 | Code licence Apache-2.0 | accepted | 2026-09-07 |
| ADR-11 | Monorepo layout and toolchain | accepted | 2026-09-07 |
| ADR-12 | Affect engine is the single source of truth for expression, gesture, voice style and wording | accepted | 2026-09-07 |
| ADR-13 | Build loop: architect edits, gate, commit on green; Aider only when it saves context | accepted (amended) | 2026-09-07 |
| ADR-14 | Scheduled tasks the character executes | accepted | 2026-09-07 |
| ADR-15 | Design system: dark theme with teal accent, one `theme.css`, className coverage test | accepted | 2026-09-07 |
| ADR-16 | Hosting: `latentpresence.com` static site + `app.latentpresence.com` app, self-hosted behind Caddy; deploy by `git pull` on the server | accepted (amended) | 2026-09-08 |
| ADR-17 | Development database is the remote MariaDB over the tunnel; latency policy for memory retrieval | accepted | 2026-09-07 |
| ADR-18 | Default character is "Alice"; concept art via comfy-mcp, mesh and rig via Rick's tools with exact instructions from the architect | accepted | 2026-09-07 |
| ADR-19 | Product name latentPresence (latentAura dropped: aura.ai exists) | accepted | 2026-09-07 |
| ADR-20 | Voice pipeline needs a GPU; latency stated as two numbers, not one | accepted | 2026-09-08 |

---

## ADR-01 Browser-first

The complete product runs in Chrome or Edge as a static site with no server, using WebGPU, AudioWorklet and Web Workers. The desktop app wraps the same build. AIRI's Tauri-to-Electron migration shows the risk of betting on a system webview for real-time audio; a real Chromium is the reference target, and the hosted BYO web version comes for free. RESEARCH §8.

## ADR-02 TypeScript core + Rust companion

`packages/core` (conversation engine, affect engine, memory kernel, scheduler) is pure TypeScript with no DOM or Node dependency so it runs in browser, worker, Node and Tauri. The companion is a Rust binary (axum) exposing a local HTTP and WebSocket API: MariaDB, document indexing, MCP host, optional GPU bridges. Python is never required to run latentPresence.

## ADR-03 VRM full-body avatar behind a renderer plugin

`packages/avatar` exposes `AvatarRenderer` (`setExpression`, `setViseme`, `playGesture`, `lookAt`, `setPose`, `tick`). First implementation is VRM via three-vrm. LAM head or Gaussian body renderers can implement the same interface later. RESEARCH §2.

## ADR-04 Vercel AI SDK + MCP

Streaming, tool calls, structured outputs and an MCP client in one Apache-2.0 TypeScript library that runs in the browser. The OpenAI-compatible provider covers Ollama, LM Studio, vLLM, llama.cpp, OpenRouter, NVIDIA (Nemotron). Native Anthropic and Google adapters where features matter. Model discovery (what Ollama and LM Studio actually have, capabilities, context length) follows the verified shapes in latentCreate's `llm-bridge` and `docs/LLM-SURFACE.md`; we port the TypeScript equivalent rather than re-derive them. RESEARCH §4.

## ADR-05 Memory kernel with MariaDB Vector

Episodic log, bi-temporal facts, editable self-model blocks, plans, schedules. MariaDB 11.8 `VECTOR` columns and HNSW index for retrieval. `MemoryStore` adapters: `mariadb` (through companion), `sqlite` with `sqlite-vec` (desktop and companion-without-MariaDB), `indexeddb` (web-only). Postgres with pgvector would work equally well and is not planned; MariaDB stays because it is Rick's preference and its vector support is native. RESEARCH §6.

## ADR-06 Cascaded voice pipeline by default

Silero VAD, Smart Turn v3 (or adaptive silence), STT provider, LLM provider, sentence splitter, TTS provider, audio queue, lip sync. `OmniProvider` (audio in, audio out) is an optional path for models like Qwen3-Omni. RESEARCH §3.

## ADR-07 Tauri 2, Windows first (amended 2026-09-07)

Development and the first release target Windows, where Tauri uses WebView2 (Chromium) and the browser-first build runs unchanged. Linux gets its Phase 0 spike on Rick's Linux machine (WebKitGTK is the risk). macOS is deferred: no hardware, and WebKit is where AIRI failed. If Tauri blocks a platform later, that platform ships as "companion + Chrome/Edge", and Electron is the documented fallback shell. Browser-first means catching other platforms up later is packaging work, not product work.

## ADR-08 Smart home through Home Assistant

Home Assistant's MCP server exposes devices and intents, and HA already bridges Google Home and Alexa. We never write vendor skills.

## ADR-09 No models shipped

The repo and installers contain no model weights. Browser-side models (VAD, STT, TTS, SER, face) download from Hugging Face on first use behind an explicit consent screen showing size and licence. Server-side models are the user's own endpoints.

## ADR-10 Licence

Apache-2.0 for the code, with `NOTICE`. Assets (character, set, CC0 clips) under CC0 or CC-BY-4.0 as appropriate. `THIRD-PARTY-LICENSES` generated at release (P9).

## ADR-11 Monorepo and toolchain

```
latentPresence/
  apps/web/            Vite + React app, deployed to app.latentpresence.com
  apps/desktop/        Tauri 2 shell (Phase 8)
  site/                static marketing site + docs + feedback form, latentpresence.com
  packages/core/       conversation engine, affect engine, memory kernel, scheduler (pure TS)
  packages/providers/  llm, stt, tts, embeddings, omni adapters
  packages/avatar/     three.js / VRM renderer, animation, lip sync, set
  packages/protocol/   shared types and companion API schema (zod)
  packages/ml-web/     worker wrappers for transformers.js / onnxruntime-web models
  companion/           Rust workspace: server, db, ingest, mcp
  assets/              CC0 clips, set, default character (large files via git LFS)
  docs/
```
pnpm workspaces, Vite, React 19, TypeScript strict, react-three-fiber, @pixiv/three-vrm, zustand, zod, oxlint, Vitest, Playwright, cargo workspace with axum, tokio, sqlx, serde. `pnpm gate` mirrors CI: `tsc -b`, oxlint, vitest, vite build, `cargo fmt --check`, clippy `-D warnings`, `cargo test`. `.gitattributes` pins `eol=lf`.

## ADR-12 Affect engine

State: PAD mood vector (slow, persisted), discrete emotion events (fast, decaying), energy, social stance. Inputs: user affect estimate, conversation events, time of day, memory triggers. Outputs: expression weights, gesture bias, gaze policy, TTS hint, and a two-line "how you feel" injection into the LLM system context. The LLM can emit `[emote:x]` tags, which become events. RESEARCH §9.

## ADR-13 Build loop (amended 2026-09-07)

Rick's standard loop, as in every latent project: **the architect (Claude Code, sometimes DeepSeek) edits, runs the gate, and commits on green.** Details in `docs/WORKFLOW.md`.
- Docs-only commits do not run the gate.
- Aider is a token-saving device only. It gets a brief when the work is broad and mechanical enough that writing it would burn the architect's context (UI wiring across many files, transcription of a reference implementation, bulk tests from a spec). Work the architect has already written and verified does not go through Aider. Launch is always `--no-auto-commits --no-dirty-commits`; the architect reviews the diff, runs the gate, and commits.
- Every task, Aider or not, carries a brief with "done when" criteria, and the review is done against the brief.

## ADR-14 Scheduled tasks

Users can ask the character to do something later or on a schedule ("every weekday at 8, summarise my inbox folder and tell me when I sit down", "remind me Thursday", "re-index my notes nightly"). Design:
- `schedules` table in the memory store: id, character, description, cron or one-shot time, task prompt, allowed tools, delivery mode (`speak_next_session`, `notify`, `silent_log`), catch-up policy (`skip`, `run_once`, `run_all`), last and next run, status.
- Execution lives in `packages/core/scheduler` and runs wherever the core is alive: the open browser tab, or the desktop app in tray mode (Phase 8 makes tray mode the "always present" path). Missed runs are handled on wake by the catch-up policy.
- Tool-only jobs that need no LLM (ingest a folder, ping Home Assistant) can be delegated to the companion so they run with the app closed.
- Results land as memory episodes and, if delivery says so, the character raises them at the next session or via an OS notification. Every scheduled job is visible and cancellable in a Schedules panel; the character confirms schedule creation aloud.

## ADR-15 Design system

Dark theme sharing the latentbeats.com tokens (ground `#0a0e1a`, panel `#161b22`, border `#2a3441`, text `#d6deeb`, muted `#8b949e`, radius 12/16 px, 180 ms transitions) with a **teal accent** instead of the suite's blue:

```
--accent: #2dd4bf;        --accent-hover: #5eead4;   --accent-dim: #0d9488;
--accent-glow: rgba(45, 212, 191, 0.22);  --accent-glow-strong: rgba(13, 148, 136, 0.42);
--on-accent: #06201d;     /* text on a filled accent button; teal is light, so white fails contrast */
```
State colours from the siblings: danger `#f85149`, success `#3fb950`, warning `#d29922`.
Rules: one `theme.css` per app is the single source of styling truth; every className used in TSX has a rule there; `theme.test.ts` (ported from latentCreate, Rick's own Apache-2.0 code) fails the gate on any className without a rule, on any computed prefix nothing answers, and on stale exemptions. No colour literals outside `:root`; a second test enforces it. The `site/` pages use the same tokens in `site/css/style.css`. Components are styled the day they are written, never in a later CSS pass.

## ADR-16 Hosting (amended 2026-09-08)

- `latentpresence.com`: static HTML in `site/` (landing, `docs/`, `feedback/`) in the style of latentbeats.com. The feedback form posts to `/api/feedback` with `source: "presence"`; Caddy proxies that path to the existing feedback API, which needs `presence` added to its source whitelist (Rick, one line in `tools/feedback-api`).
- `app.latentpresence.com`: the `apps/web` build, static. It talks to the user's own endpoints and, when present, to the local companion at `http://127.0.0.1:<port>`. Chrome allows an HTTPS page to call `localhost` (mixed-content exemption) but applies Local Network Access rules: the companion must answer the CORS preflight including `Access-Control-Allow-Private-Network: true`, and the user sees a one-time permission prompt. Same for Ollama and LM Studio from the hosted app. Verified in P8-T03.
- **Deployment (amended 2026-09-08).** The server has a checkout of this repository and deploys with
  `git pull`, then `pnpm install --frozen-lockfile && pnpm build`, which is what puts `apps/web/dist`
  on disk — it is gitignored, so a pull alone does not bring it. Caddy serves `<checkout>/site` for
  `latentpresence.com` and `<checkout>/apps/web/dist` for `app.latentpresence.com`; Rick configures
  Caddy. No GitHub Pages, and no rsync: the `scripts/deploy.sh` written for P0-T03 was deleted the
  day the first deploy proved it unnecessary. First live deploy of the site, docs and feedback form:
  2026-09-08.

## ADR-20 Voice pipeline performance (accepted 2026-09-08)

From Spike A (`docs/spikes/A-voice-loop.md`), measured on Rick's machine over twenty
clean turns.

**The single 800 ms target in RESEARCH §3.3 is replaced by two numbers.** One figure
covering both the pipeline and the model call hides which half is this project's
responsibility, and the measured pipeline already exceeds 800 ms with no model in the
loop.

- **Pipeline: under 500 ms from end of speech to first audio, excluding the model call.**
  Measured 435 ms on WebGPU with fp32, of which recognition is 180 ms and synthesis
  245 ms. This is the number the project owns and can be held to.
- **End to end: reported, not promised.** It depends on which LLM the user points at, and
  a local model's first token can exceed the whole remaining allowance. The transcript
  panel shows both (P1-T11 already specifies latency badges).

**WebGPU is required for synthesis, not preferred.** Kokoro takes 3779 ms on wasm against
245 ms on WebGPU — fifteen times slower, and not a conversation. ADR-01 stands as
browser-first, but a machine without WebGPU is steered to a server TTS endpoint rather
than left on wasm Kokoro. The BYO provider design already allows this, so ADR-06 is
unchanged.

**Recognition precision is chosen per stage and never inherited.** transformers.js
defaults to q8 on wasm and fp32 on WebGPU. The WebGPU q8 path returns fluent nonsense —
the same string for every utterance — with no error. P1-T06 sets `dtype` explicitly and
does not offer q8 on WebGPU.

**Consequence for P0-T07.** The VAD hangover is 512 ms of the 947 ms total: more than half
the latency of the working configuration is waiting to be sure the person stopped talking.
Smart Turn v3 is therefore load-bearing rather than an optimisation, and its spike should
be treated as such.

**Amended by ADR-21 (2026-09-09).** Spike D answered that consequence: Smart Turn v3 ships,
and turn detection is now measured work rather than the tuning constant this entry carved
out of the 435 ms. The 500 ms figure stands; what counts against it has changed.


## ADR-17 Development database

Development uses an always-on MariaDB on one of Rick's Linux servers. Connection details live in `.env` (never committed); the companion reads `DATABASE_URL`. Because a memory retrieval may cross a WAN round trip, the memory kernel is designed for it from day one: one batched retrieval call per turn, a small in-process cache for self-model blocks and recent turns, and writes that never block the speaking path. Users without a MariaDB get the SQLite adapter automatically.

**Amended 2026-09-09.** The host moved from `10.0.0.1` over the tunnel to `192.168.40.101`
on the LAN, because the first is MariaDB 10.11.18 and the `VECTOR` type needs 11.7.1+. The
new one is 11.8.8 and does everything P0-T06 asks of it.

The design above stands, and is now measured rather than assumed. Thirty round trips to
each: **39.8 ms p50 over the tunnel, 0.43 ms p50 on the LAN** (`docs/SURFACE.md`). Against
the 100 ms per-turn retrieval budget, one statement fits either way and two do not fit
remotely — so "one batched retrieval call per turn" is a requirement with a number behind
it, not a precaution.

**What the move costs us:** development no longer crosses a WAN, so the dev loop will not
notice a chatty retrieval design. The pressure that would have caught it is gone. P4 keeps
the one-call rule deliberately, and P0-T06 reports both networks rather than only the fast
one — a LAN figure alone would say the network is free, which is true in exactly one
deployment.

## ADR-18 Default character: Alice

Concept and turnaround images are generated by the architect through the connected ComfyUI (comfy-mcp) during a Claude Code session, reviewed by Rick. Mesh generation, rigging and blendshapes are Rick's tools; the architect writes exact, step-by-step instructions (tool, settings, export options, validation) into `docs/pipeline/character.md` before Rick starts. Until Alice lands, a redistributable sample VRM is the placeholder.

## ADR-21 Turn detection inside the pipeline budget (accepted 2026-09-09)

From Spike D (`docs/spikes/D-smart-turn.md`), measured over eight runs on Rick's machine.

**Smart Turn v3 replaces the VAD hangover**, on fp32/WebGPU with a 100 ms candidate silence
and a 0.7 threshold: 168 ms median from end of speech to an answer against the 512 ms it
replaces, 0 of 10 held pauses interrupted in that configuration and 0 of 51 across the five
runs after the first. The int8 build will not load on WebGPU at all and is a no-GPU
fallback rather than a cheaper default.

**Turn detection now counts inside ADR-20's 500 ms pipeline budget.** ADR-20 measured
435 ms with the hangover carved out, on the grounds that it was a tuning constant rather
than work. It is no longer a tuning constant: it is a model with a measured cost, and a
budget that excludes it is measuring the easy part. Counted honestly the best measured path
is **553 ms against a 500 ms budget** — 53 ms over.

**The budget stays at 500 ms rather than being restated to fit.** Two things close the gap
and both are P1's to do:

- **Recognition overlaps turn detection.** They consume the same buffered window and
  neither depends on the other, so both start when the candidate is cut. Turn detection
  finishes 40 ms in; recognition takes 180 ms. The cost is a speculative recognition pass
  per candidate that does not end the turn — median one candidate per turn, so usually the
  pass that gets kept. P1-T06 and P1-T07 build this; it is arithmetic here, not a
  measurement, and needs verifying when it lands.
- **The candidate silence is a dial.** 128 of the 168 ms is deliberate waiting, not work.
  60–80 ms is untested and is the obvious next lever.

Alternative considered and rejected: restating the budget at 600 ms to include turn
detection. That would make the number pass by moving it, and the two levers above are real
and unexercised. If they land and the figure is still over 500 ms, the budget is wrong and
should be changed then, with the measurement to justify it.

**Consequence for P1-T07.** It ships Smart Turn v3, not adaptive silence. The 500 ms
hangover stays as a backstop; whether it survives P1-T08's barge-in work is a separate
question. The browser turn detector must set its build and backend explicitly and must not
offer int8 on WebGPU — the same rule ADR-20 set for recognition, for the same reason.

## ADR-19 Name

latentPresence. Domain `latentpresence.com` owned. Package scope `@latentpresence/*`, companion binary `latentpresence-companion`.
