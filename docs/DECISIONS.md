# Decisions (ADR log)

One entry per decision. `proposed` until Rick confirms, then `accepted`. Superseded entries stay, marked `superseded by ADR-xx`. Reasoning lives in `docs/RESEARCH.md`; this file records the call.

| ID | Decision | Status | Date |
|---|---|---|---|
| ADR-01 | Browser-first; desktop and web share one frontend | accepted | 2026-09-07 |
| ADR-02 | TypeScript core + Rust companion; no Python in the core | accepted | 2026-09-07 |
| ADR-03 | Full-body semi-realistic VRM 1.0 avatar in three.js behind a renderer plugin interface | accepted (amended) | 2026-09-11 |
| ADR-04 | Vercel AI SDK as LLM and tool harness; MCP for tools | accepted | 2026-09-07 |
| ADR-05 | TS memory kernel with `MemoryStore` adapters; MariaDB 11.8 Vector primary, SQLite and IndexedDB fallbacks; **server tuning is a shipping requirement** | accepted (amended) | 2026-09-11 |
| ADR-06 | Cascaded voice pipeline by default; omni models optional; **Smart Turn v3, not adaptive silence** | accepted (narrowed) | 2026-09-09 |
| ADR-07 | Desktop shell: Tauri 2, **Windows first**; **Linux ships as companion + Chrome — no WebGPU in WebKitGTK (2026-09-09)**; **Windows/WebView2 measured and confirmed (2026-09-11)**; macOS deferred; Electron is the fallback | accepted (amended) | 2026-09-11 |
| ADR-08 | Smart home via Home Assistant MCP only | accepted | 2026-09-07 |
| ADR-09 | No models shipped; runtime download with consent and licence display, or BYO endpoints | accepted | 2026-09-07 |
| ADR-10 | Code licence Apache-2.0 | accepted | 2026-09-07 |
| ADR-11 | Monorepo layout and toolchain; **two cargo workspaces, `pnpm gate` compiles one** | accepted (amended) | 2026-09-11 |
| ADR-12 | Affect engine is the single source of truth for expression, gesture, voice style and wording | accepted | 2026-09-07 |
| ADR-13 | Build loop: architect edits, gate, commit on green; Aider only when it saves context | accepted (amended) | 2026-09-07 |
| ADR-14 | Scheduled tasks the character executes | accepted | 2026-09-07 |
| ADR-15 | Design system: dark theme with teal accent, one `theme.css`, className coverage test | accepted | 2026-09-07 |
| ADR-16 | Hosting: `latentpresence.com` static site + `app.latentpresence.com` app, self-hosted behind Caddy; deploy by `git pull` on the server | accepted (amended) | 2026-09-08 |
| ADR-17 | Development database is a MariaDB 11.8 on the LAN; one batched retrieval call per turn | accepted (amended) | 2026-09-09 |
| ADR-18 | Default character is "Alice"; concept art via comfy-mcp, mesh and rig via Rick's tools with exact instructions from the architect | accepted | 2026-09-07 |
| ADR-19 | Product name latentPresence (latentAura dropped: aura.ai exists) | accepted | 2026-09-07 |
| ADR-20 | Voice pipeline needs a GPU; latency stated as two numbers, not one | accepted (amended) | 2026-09-11 |
| ADR-22 | LLM discovery capabilities can be unknown (`LlmModel.capabilities` nullable) | proposed | 2026-09-11 |

---

## Phase 0 retrospective — 2026-09-11 (P0-T09)

Every ADR read against every measured result. **One ADR contradicted a measurement and has
been amended; five said less than the evidence supports and now say it.** No ADR was
reversed, and no new decision was needed — ADR-07's Linux clause was the only one that
fired, and it fired as written.

| ADR | Checked against | Outcome |
|---|---|---|
| 01 Browser-first | Spike E, both legs | **Confirmed, and it was the bet under test.** Noted that "the desktop app wraps the same build" is no longer true on Linux |
| 03 VRM avatar | Spike B | Confirmed at 120.5 fps; **linked**, and the fifteen-Oculus-to-five-VRM viseme mapping recorded as an interface obligation |
| 05 Memory kernel | Spike C | Confirmed; **linked**, and the `mhnsw_max_cache_size` shipping requirement given a decision record it did not have |
| 06 Cascaded pipeline | Spike D / ADR-21 | **Narrowed** — "(or adaptive silence)" removed; it was settled and should not read as a live option |
| 07 Tauri, Windows first | Spike E, both legs | **Contradiction fixed.** It still said Windows was unmeasured and the spike open. Both are now false |
| 11 Monorepo and toolchain | the repo | **Drift recorded** — `apps/desktop/` exists before Phase 8, and there are two cargo workspaces of which `pnpm gate` compiles one |
| 17 Development database | Spike C | Confirmed with arithmetic; **linked** |
| 20 Voice performance | Spikes A, D, E | **Amended** — the 3779 ms wasm figure was single-threaded, and that path matters more now Linux ships as Chrome |
| 21 Turn detection | Spike D | Current; no change |
| 02, 08, 09, 10, 12, 13, 14, 15, 16, 18, 19 | — | Unaffected. **04, 08, 12 and 14 have no Phase 0 evidence at all** and are carried into Phase 1 unexercised, which is a gap in coverage rather than in the decisions |

**Every spike write-up is now linked from this file**: A from ADR-20, B from ADR-03, C from
ADR-05 and ADR-17, D from ADR-21, E from ADR-01, ADR-07, ADR-11 and ADR-20.

**The two things Phase 0 got wrong about its own method**, both worth carrying forward:
absence from a document was twice treated as a fact and twice disproved by a single live
call (WebGPU on WebKitGTK, which is why Spike E existed at all; and the Notification API
under Tauri, which is why `docs/SURFACE.md` carries a correction). And a measurement is not
a result until the thing being measured is named — Spike C's first benchmark flattered
itself with a periodic fixture, and Spike B's first frame rate was taken at a quarter of the
budgeted pixels.

---

## ADR-01 Browser-first

The complete product runs in Chrome or Edge as a static site with no server, using WebGPU, AudioWorklet and Web Workers. The desktop app wraps the same build. AIRI's Tauri-to-Electron migration shows the risk of betting on a system webview for real-time audio; a real Chromium is the reference target, and the hosted BYO web version comes for free. RESEARCH §8.

**This was the bet Phase 0 actually tested, and it held** (2026-09-11). The sentence "a real
Chromium is the reference target" was written from AIRI's experience rather than our own
measurement. Spike E then measured a non-Chromium system webview and found `navigator.gpu`
absent from WebKitGTK altogether, while WebView2 — a real Chromium — provided a hardware
adapter, a microphone and AudioWorklet with nothing taken away. Browser-first is what made
that survivable: the Linux answer is a packaging change (`companion + Chrome`), not a
product one, exactly as this entry predicted.

**One clause to read carefully now.** "The desktop app wraps the same build" is no longer
true on every platform — on Linux there is no wrapper, the browser *is* the app. That is
ADR-07's fallback working as designed rather than a contradiction here, but anything written
later that assumes a wrapper exists everywhere is wrong. `docs/spikes/E-tauri.md`.

## ADR-02 TypeScript core + Rust companion

`packages/core` (conversation engine, affect engine, memory kernel, scheduler) is pure TypeScript with no DOM or Node dependency so it runs in browser, worker, Node and Tauri. The companion is a Rust binary (axum) exposing a local HTTP and WebSocket API: MariaDB, document indexing, MCP host, optional GPU bridges. Python is never required to run latentPresence.

## ADR-03 VRM full-body avatar behind a renderer plugin (amended 2026-09-11)

`packages/avatar` exposes `AvatarRenderer` (`setExpression`, `setViseme`, `playGesture`, `lookAt`, `setPose`, `tick`). First implementation is VRM via three-vrm. LAM head or Gaussian body renderers can implement the same interface later. RESEARCH §2.

**Confirmed by measurement 2026-09-09** (`docs/spikes/B-vrm-lipsync.md`). A full-body VRM 1.0
with MToon, spring bones and constraints runs at **120.5 fps median at 1916×1076** on an
RTX 5060 Ti, and quadrupling the pixels moved neither the median nor the 5th percentile —
the scene is display-bound, not fill-rate bound, so 1080p is not the ceiling.

**One thing the spike changed about `setViseme`.** wawa-lipsync emits **fifteen Oculus
visemes; VRM has five**. The mapping is not a detail of the lip-sync library, it is part of
what any `AvatarRenderer` implementation must do, and it lives in `packages/avatar` with
tests rather than in the spike. A second renderer implementing this interface inherits that
obligation.

**Still unmeasured:** a different class of GPU. The comparison could not be run because the
board has no integrated graphics, so every avatar number here comes from one card that is
well above mid-range. Nothing depends on it yet; P2 should not quote 120.5 fps as a system
requirement.

## ADR-04 Vercel AI SDK + MCP

Streaming, tool calls, structured outputs and an MCP client in one Apache-2.0 TypeScript library that runs in the browser. The OpenAI-compatible provider covers Ollama, LM Studio, vLLM, llama.cpp, OpenRouter, NVIDIA (Nemotron). Native Anthropic and Google adapters where features matter. Model discovery (what Ollama and LM Studio actually have, capabilities, context length) follows the verified shapes in latentCreate's `llm-bridge` and `docs/LLM-SURFACE.md`; we port the TypeScript equivalent rather than re-derive them. RESEARCH §4.

## ADR-05 Memory kernel with MariaDB Vector (amended 2026-09-11)

Episodic log, bi-temporal facts, editable self-model blocks, plans, schedules. MariaDB 11.8 `VECTOR` columns and HNSW index for retrieval. `MemoryStore` adapters: `mariadb` (through companion), `sqlite` with `sqlite-vec` (desktop and companion-without-MariaDB), `indexeddb` (web-only). Postgres with pgvector would work equally well and is not planned; MariaDB stays because it is Rick's preference and its vector support is native. RESEARCH §6.

**Confirmed by measurement 2026-09-09** (`docs/spikes/C-mariadb-vector.md`). MariaDB 11.8.8
stores `VECTOR(768)` bit-exactly and answers a top-8 at **100k rows in 4.90 ms median,
8.47 ms p95** on the LAN, with `EXPLAIN` naming the index at both 10k and 100k rather than
the timing being taken as proof. Against the 100 ms per-turn retrieval budget that is around
twelve times the headroom needed locally.

**Amendment 2026-09-11 — server tuning is a shipping requirement, and this ADR is where it
belongs.** The spike's real finding was a default. `mhnsw_max_cache_size` ships at **16 MB**
against 307 MB of vectors at 100k rows, which cost a **5x** query slowdown and made 100k
rows effectively unreachable until it was raised. It is a **`GLOBAL`-only** variable: no
application user can set it, and latentPresence cannot detect or fix it from inside the
product.

That makes it a documentation obligation rather than a code one, and it had no decision
record until this retrospective. **Whatever ships with a MariaDB path must tell the operator
to raise `mhnsw_max_cache_size` past the working-set size**, with the arithmetic for
choosing it. P4 owns the wording; this ADR owns the fact that it is not optional.

**What is not established:** recall. Everything above is latency. Recall is not measurable
from a random fixture — `mhnsw_ef_search` is session-settable and cheap to raise (p95 still
12 ms at 320), so it is an affordable dial, but what it should be set *to* is a P4 question
with real embeddings behind it.

## ADR-06 Cascaded voice pipeline by default (narrowed 2026-09-09)

Silero VAD, Smart Turn v3, STT provider, LLM provider, sentence splitter, TTS provider, audio queue, lip sync. `OmniProvider` (audio in, audio out) is an optional path for models like Qwen3-Omni. RESEARCH §3.

**Narrowed 2026-09-09 by ADR-21.** This entry originally read "Smart Turn v3 (or adaptive
silence)". Spike D settled it — Smart Turn v3 ships and adaptive silence does not, so the
alternative is removed rather than left standing as a live option. The 500 ms hangover
survives only as a backstop behind the model.

## ADR-07 Tauri 2, Windows first (amended 2026-09-07, 2026-09-09, 2026-09-11)

Development and the first release target Windows, where Tauri uses WebView2 (Chromium) and the browser-first build runs unchanged. Linux gets its Phase 0 spike on Rick's Linux machine (WebKitGTK is the risk). macOS is deferred: no hardware, and WebKit is where AIRI failed. If Tauri blocks a platform later, that platform ships as "companion + Chrome/Edge", and Electron is the documented fallback shell. Browser-first means catching other platforms up later is packaging work, not product work.

**Amendment 2026-09-09 — the Linux clause fired.** P0-T08 Spike E measured the Tauri webview on Fedora 44 with WebKitGTK 2.52.5: `navigator.gpu` is **undefined**, and the JS bindings for it are not in the build. Not a device that cannot be found — an API that is not there. Spikes A, D and B all require WebGPU, so **Linux ships as companion + Chrome**, which is this ADR's own fallback rather than a new decision. Windows/WebView2 is unchanged and still unmeasured; the spike does not close until it is. Two constraints come with the fallback and are Phase 8's to handle, not new decisions: Chrome on Linux gave **no WebGPU adapter as launched** on that box (its GPU sandbox could not read the Vulkan ICDs) and needed `--disable-gpu-sandbox` for a hardware adapter, and forcing WebGPU on with `--enable-unsafe-webgpu` yielded **SwiftShader**, software, which passes a naive check. `docs/spikes/E-tauri.md`.

**Amendment 2026-09-11 — the Windows leg, and the spike closes.** The paragraph above said
"Windows/WebView2 is unchanged and still unmeasured; the spike does not close until it is."
It is measured now. WebView2 **152.0.4191.66** provides a WebGPU adapter that is real
hardware (`nvidia / blackwell`, and the probe rejects a software rasteriser, so it means
it), a live microphone, AudioWorklet, WebGL 2 on the discrete card, and a working tray.
**Windows-first stands exactly as this ADR wrote it**, on evidence rather than on the
expectation that WebView2 is Chromium.

Two things the Windows leg adds for Phase 8, neither of them a decision:
- **Toasts need an installed app.** The Rust notification call returns `Ok` and draws
  nothing from a dev binary, because Windows routes by AppUserModelID and only a Start Menu
  shortcut supplies one. P8-T01's installer is the fix; **P8-T05 must not be tested from
  `cargo run`**, and that an installed build does draw the toast is still unverified.
- **A capability file is written against the plugins registered, not against the code the
  page appears to contain.** `tauri-plugin-notification` polyfills `window.Notification`, so
  a page with no Tauri code in it still crosses the ACL.

## ADR-08 Smart home through Home Assistant

Home Assistant's MCP server exposes devices and intents, and HA already bridges Google Home and Alexa. We never write vendor skills.

## ADR-09 No models shipped

The repo and installers contain no model weights. Browser-side models (VAD, STT, TTS, SER, face) download from Hugging Face on first use behind an explicit consent screen showing size and licence. Server-side models are the user's own endpoints.

## ADR-10 Licence

Apache-2.0 for the code, with `NOTICE`. Assets (character, set, CC0 clips) under CC0 or CC-BY-4.0 as appropriate. `THIRD-PARTY-LICENSES` generated at release (P9).

## ADR-11 Monorepo and toolchain (amended 2026-09-11)

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

**Amendment 2026-09-11 — two things drifted from this text during Phase 0, recorded here so
the layout above stays true.**

- **`apps/desktop/` says "(Phase 8)" and exists now.** P0-T08 needed a shell to measure a
  webview, so it was built early. It is a spike artifact until P8-T01; the layout is
  unchanged, only the timing.
- **There are two cargo workspaces, and `pnpm gate` only compiles one.** `apps/desktop/src-tauri`
  is its own workspace and is deliberately outside `rust:clippy` and `rust:test`, because
  making every gate through Phases 1–7 build wry, tao and a platform webview is a real tax
  on the build loop for a crate nobody is editing — and on CI's ubuntu runner it would need
  `libwebkit2gtk-4.1-dev` installed before the gate could start. **`pnpm gate:desktop` is the
  opt-in command that does check it** (fmt and clippy). The consequence is stated rather than
  hidden: **CI never compiles that crate**, so a change which breaks it is found by running
  the shell. P8-T01 should fold it into the compile gate as part of making the desktop app
  real. `docs/spikes/E-tauri.md`.

Playwright is still unused: it is in the toolchain for `/gallery` screenshots and nothing in
Phase 0 needed one.

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

## ADR-20 Voice pipeline performance (accepted 2026-09-08, amended 2026-09-09, 2026-09-11)

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

**Amended 2026-09-11 — the 3779 ms was single-threaded, and the fallback now matters more
than it did.** Spike E found `SharedArrayBuffer` undefined in **every container measured** —
WebKitGTK, WebView2, and Chrome on both operating systems — because the Vite dev server
sends no `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy`. onnxruntime-web's
*threaded* wasm build requires it, so the wasm figure above was taken with one thread and
**the threaded wasm path has never been measured at all**.

The number is not wrong; it is incomplete, and the gap moved. When it was taken, wasm was
the sad path for a machine without a GPU. Since ADR-07's Linux clause fired, **Chrome on
Linux is a shipping path**, and the Linux leg measured that same Chrome giving *no WebGPU
adapter as launched* on Rick's box. A Linux user who does not pass `--disable-gpu-sandbox`
lands on wasm, which is the configuration this ADR has the least evidence about.

So: "WebGPU is required for synthesis, not preferred" stands, and the steer to a server TTS
endpoint stands. What changes is that **P1 owes a threaded-wasm measurement with the
isolation headers set**, rather than treating 3779 ms as the last word on the fallback.
`docs/spikes/E-tauri.md`.


## ADR-17 Development database (amended 2026-09-09)

Development uses an always-on MariaDB on one of Rick's Linux servers. Connection details live in `.env` (never committed); the companion reads `DATABASE_URL`. Because a memory retrieval may cross a WAN round trip, the memory kernel is designed for it from day one: one batched retrieval call per turn, a small in-process cache for self-model blocks and recent turns, and writes that never block the speaking path. Users without a MariaDB get the SQLite adapter automatically.

**Amended 2026-09-09.** The host moved from `10.0.0.1` over the tunnel to `192.168.40.101`
on the LAN, because the first is MariaDB 10.11.18 and the `VECTOR` type needs 11.7.1+. The
new one is 11.8.8 and does everything P0-T06 asks of it.

The design above stands, and is now measured rather than assumed. Thirty round trips to
each: **39.8 ms p50 over the tunnel, 0.43 ms p50 on the LAN**
(`docs/spikes/C-mariadb-vector.md`, `docs/SURFACE.md`). Against
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

## ADR-22 LLM discovery capabilities can be unknown (proposed 2026-09-11)

**Decision:** `LlmModel.capabilities` becomes nullable (`capabilities: null` = the endpoint
did not enrich, so nothing is known).

**Why.** latentCreate's `LLM-SURFACE.md` §11 documents that the OpenAI-compatible
`/v1/models` list carries no capability data at all: embedding models are listed
indistinguishably from chat models, remote/cloud models are invisible, and thinking is
unknowable before a call. Only Ollama's native `/api/tags` enrichment (P1-T02) makes these
facts available. The previous contract forced a concrete `LlmCapabilities`, so discovery
had to guess — an unenriched embedding model would be presented as "can chat", a remote
model as "local". `null` is the only truthful answer for an endpoint that did not enrich,
and it is the contract's existing pattern (`contextLength` was already nullable for the
same reason).

**Consequences.** The chat picker (P1-T10) must treat `null` capabilities as *unknown*: it
must not hide the model as embedding-only, and must not present it as a local or
can-chat model — SURFACE 11.2 forbids presenting unknown as either. The Ollama discovery
path (native `/api/tags`) never returns `null`, so nothing is lost on the primary local
case.
