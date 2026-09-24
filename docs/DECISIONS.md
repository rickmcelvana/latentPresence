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
| ADR-12 | Affect engine is the single source of truth for expression, gesture, voice style and wording | accepted (amended) | 2026-09-24 |
| ADR-13 | Build loop: architect edits, gate, commit on green; Aider only when it saves context | accepted (amended) | 2026-09-07 |
| ADR-14 | Scheduled tasks the character executes | accepted | 2026-09-07 |
| ADR-15 | Design system: dark theme with teal accent, one `theme.css`, className coverage test | accepted | 2026-09-07 |
| ADR-16 | Hosting: `latentpresence.com` static site + `app.latentpresence.com` app, self-hosted behind Caddy; deploy by `git pull` on the server | accepted (amended) | 2026-09-08 |
| ADR-17 | Development database is a MariaDB 11.8 on the LAN; one batched retrieval call per turn | accepted (amended) | 2026-09-09 |
| ADR-18 | Default character is "Alice"; concept art via comfy-mcp, mesh and rig via Rick's tools with exact instructions from the architect | accepted | 2026-09-07 |
| ADR-19 | Product name latentPresence (latentAura dropped: aura.ai exists) | accepted | 2026-09-07 |
| ADR-20 | Voice pipeline needs a GPU; latency stated as two numbers, not one; **Kokoro fp32 only on WebGPU** | accepted (amended) | 2026-09-13 |
| ADR-22 | LLM discovery capabilities can be unknown (`LlmModel.capabilities` nullable) | accepted | 2026-09-12 |
| ADR-23 | Inline tag types stay in `packages/core` until the tag protocol exists | accepted | 2026-09-12 |
| ADR-24 | TTS audio crosses as Float32 PCM; the server adapter asks for `wav` and parses it itself | accepted | 2026-09-12 |
| ADR-25 | A model-ended turn is provisional until the hangover would have fired; speech resuming inside it retracts the end | accepted (amended) | 2026-09-13 |
| ADR-26 | Barge-in ducks on speech and commits on sustained speech; "heard" is what rendered before the fade's midpoint | accepted | 2026-09-13 |
| ADR-27 | Synthesised sentences are trimmed to their voice plus 50 ms / 250 ms before they are queued | accepted | 2026-09-13 |
| ADR-28 | Backchannels are words, said in pauses Smart Turn judges unfinished, at most one per 8 s; a clip the user talks into ducks and finishes | accepted | 2026-09-13 |
| ADR-29 | Browser reachability is measured per endpoint; endpoints that refuse browser origins (NVIDIA) go through an allow-listed companion relay; API keys are WebCrypto-encrypted with a non-extractable key | accepted | 2026-09-14 |
| ADR-30 | The tag protocol: `[emote:x]`/`[gesture:x]`, a closed gesture vocabulary, tags promoted onto `assistant.sentence`, never on tokens | accepted (amended) | 2026-09-21 |
| ADR-31 | Animation clips are converted to `.vrma` in node, not retargeted in Blender; any VRM avatar plays them (retarget at load) | accepted | 2026-09-24 |

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

**Amended 2026-09-23, after P2-T01–T05.** The interface held unchanged; four things were
learned under it.
- **`setViseme` is five channels, not one mouth.** Each shape keeps its weight until set
  again and `sil` closes all five, so a lip-sync driver can blend (P2-T01). Any renderer
  implements that rule — it is shared code (`applyViseme`), not a convention.
- **wawa-lipsync is ported, not depended on** (P2-T04). It cannot attach to a node in
  another `AudioContext`, and ours is an AudioWorklet; its ~200-line classifier is now
  `packages/avatar/src/lipsync/classifier.ts` (MIT, NOTICE), golden-tested against the
  original. Measured on Kokoro through the real output graph: the mouth trails the sound
  by ~50–60 ms (R-11, D-24), against an 80 ms bar.
- **The life layer and lip sync ride on top of clips** through `AdditivePose`, which undoes
  itself each frame — a mixer only writes the bones its clip animates (P2-T02).
- **With the full stage the same card holds 120.5 fps median at 1080p**, shadows on or off,
  worst frame 8.5 ms (R-13, 2026-09-23, at 120 Hz) — Spike B's bare-avatar median exactly, so
  the room, three lights and a shadow map cost nothing measurable and the page is still
  display-bound. The different-GPU reading is still owed (R-1, R-13's laptop half).

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

**Amended 2026-09-24 (P3-T03), protocol change, additive:** `PromptContext` gains `affect: AffectState | null` (default null), so `renderSystemPrompt` stays pure and renders the two lines itself — the feeling in words and a reply-length bias, never numbers — and a null affect leaves the prompt byte-identical to before. `PromptContextInput` (`z.input`) is exported so callers may omit the nullable fields. `PROTOCOL_VERSION` stays 1. **The TTS hint is not the whole voice:** Kokoro, the default, has no emotion control, so every voice also gets prosody we own — a pace multiplier (±15%, clamped to Kokoro's 0.75–1.25) and the pause after each sentence (150–450 ms in place of ADR-27's 250 ms tail), carried by `Reply`'s `voiceStyle`. A sentence's own `[emote:x]` names the hint's feeling for that line, so voice and face never disagree. `pnpm live:affect`: the same six prompts in three engine-made moods — glm-5.2:cloud 36 / 21 / 68 words (rest / low / bright), claude-fable-5-1 37 / 20 / 87.

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

## ADR-20 Voice pipeline performance (accepted 2026-09-08, amended 2026-09-09, 2026-09-11, 2026-09-13, 2026-09-22)

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

  **Confirmed with a person and a real model, 2026-09-22 (R-8).** Both halves held. The
  pipeline's own share was unchanged — turn ends 218–279 ms after speech, first-sentence
  synthesis 299–818 ms — while end-to-end ran **1.8–6.1 s on `glm-5.2:cloud` and 4.8–9.2 s
  on a local `gemma4:12b-it-qat`**, plus a 17.8 s cold load on its first turn. The clause
  about a local model's first token was written as a caution and is now a measurement.
  **It also corrects an intuition the ADR did not address: local is not the fast option.**
  On this hardware the local 12B model was two to four times slower to first audio than the
  cloud endpoint, so nothing in this project should recommend local inference *for latency*.
  `docs/SURFACE.md`, `docs/runs/R-8-history-2026-09-22.md`.

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


**Amended 2026-09-13 (P1-T08) — synthesis precision is fp32, and the pipeline reads ~765 ms
in a browser.** Three measurements in the Browser pane, all in `docs/SURFACE.md`:

- **Kokoro `q8` on WebGPU is the recognition failure again.** Speech-shaped audio that
  Moonshine could not read a word of in three sentences, where fp32 through the same worker
  matched node to the frame and read back exactly. "Precision is chosen per stage and never
  inherited" now covers synthesis: every quantised Kokoro precision is refused on WebGPU, in
  the provider and in the worker.
- **Spike A's "first audio" was ~310 ms optimistic.** Kokoro pads each sentence with ~310 ms
  of silence in front, and the spike timed the first frame, not the first voice. ADR-27
  trims it.
- **Counted end to end in the browser, the pipeline is ~765 ms** (718–811 over ten warm
  turns, scripted model, output latency included), against the 500 ms this ADR owns. The
  first sentence's synthesis is ~380 ms of it, at ~4.6 ms/char. The budget stands, as ADR-21
  said it should until the levers are exercised: a first-chunk cap on the browser path is
  the unexercised one, and P1-T14 is where the figure is judged.


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

**P1-T07, 2026-09-13 — the overlap is built, and the 168 ms reproduces.** Recognition and
the judge receive the same candidate buffer in one synchronous step, and a test drives the
real drivers over fake workers to show both workers hold the window before either answers.
On Kokoro speech through the shipped Silero and Smart Turn code, with Spike D's WebGPU
answer latency applied on the audio clock, complete sentences end **median 168 ms, worst
220 ms** after the labelled end. That reproduces Spike D's figure on new audio; it is
**not a new browser measurement** — node has no WebGPU, so the browser number on this
onnxruntime version is still unmeasured. Two things changed around this ADR rather than in
it: recognition is cancelled only when speech resumes, never on a low probability, because
the hangover then closes the turn on the same audio; and ADR-25 makes a model end
retractable, after the live check found it cutting sentences at inner pauses.

## ADR-19 Name

latentPresence. Domain `latentpresence.com` owned. Package scope `@latentpresence/*`, companion binary `latentpresence-companion`.

## ADR-22 LLM discovery capabilities can be unknown (accepted 2026-09-12)

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

## ADR-23 Inline tag types stay in core until the tag protocol exists (accepted 2026-09-12)

**Decision:** the sentence chunker's `InlineTag` and `SpeechChunk` are plain TypeScript
types in `packages/core/chunker`, not zod schemas in `packages/protocol`, and
`ConversationEventSchema` gains no variant for an emote or a gesture in P1-T04.

**Why.** `docs/LLM-PLAN.md` describes P1-T04 as stripping tags "into events with character
offsets", and no such event exists: the union carries `assistant.sentence` and nothing for
a tag. Adding one now would fix the wire shape of a protocol **P1-T12 has not designed**.
P1-T12 owns the persona text that asks a model for tags and the vocabulary it may use; it
may well conclude that a gesture needs a duration, or a target, or a strength, none of
which P1-T04 can know. A protocol variant guessed here would be an interface change to
un-guess later, and `packages/protocol` changes are the one thing this repo makes
expensive on purpose.

The seam is left deliberately cheap to close: `SpeechChunk.index` is the same 0-based
monotonic number `assistant.sentence.index` already carries, so promoting the tag shape is
a field copy rather than a redesign.

**What this costs.** Nothing consumes tags until P2-T01, so nothing is blocked. The risk
is that the core-local type quietly becomes the de facto protocol by being convenient.
**P1-T12 must decide explicitly** whether to promote it, amend it, or replace it — and
say so in its session note rather than inheriting this by default.

**Reconsider when:** P1-T12 lands. Accepted 2026-09-12, which does **not** dissolve the
obligation: P1-T12 still has to decide explicitly whether to promote this shape into the
protocol, amend it, or replace it.

**Closed 2026-09-21 by P1-T12: promoted, unchanged in shape.** `InlineTag` and
`InlineTagKind` are now zod schemas in `packages/protocol/src/conversation.ts` and the
chunker re-exports them, so the seam closed as a field copy exactly as predicted — the four
fields are the same four, and `SpeechChunk.index` did line up with
`assistant.sentence.index`. The one thing the ADR guessed wrong is worth recording: it
worried a gesture might need "a duration, or a target, or a strength". The pilot found the
opposite — a model emits one bare label and nothing else — so the shape gained nothing and
only `known` widened, to cover the new gesture vocabulary. See **ADR-30**.

## ADR-24 TTS audio crosses as Float32 PCM, decoded by the adapter (accepted 2026-09-12)

**Decision:** every `TTSProvider` yields `SpokenAudioChunk` — mono `Float32Array` samples
with the rate they were made at. The OpenAI-compatible adapter therefore asks for
`response_format: 'wav'` and parses the RIFF container itself
(`packages/providers/src/tts/wav.ts`) rather than handing bytes to
`AudioContext.decodeAudioData`. Compressed formats — mp3, opus, aac, flac — are not
offered.

**Why.** Three reasons, in the order they decided it.

1. **`decodeAudioData` is a DOM API.** Using it would make every test of the TTS adapter a
   browser test, for a package whose whole point is that a provider is testable without
   one. The LLM adapters set that precedent with an injected `fetch`; this is the same
   move for audio.
2. **`wav` states its own sample rate and `pcm` does not.** Headerless PCM would need the
   rate from configuration, which for an endpoint the user pasted a URL for is a guess —
   and SURFACE 11 forbids presenting a guess as a fact. `pcm` remains available for a user
   who states the rate, and a WAV header always wins over the configured value.
3. **The compression buys nothing here.** One sentence of 24 kHz mono is tens of kilobytes
   over a LAN or a TLS connection the user already pays for, and every codec would need a
   decoder in the bundle for audio that is about to be played once.

**What this costs.** A server that cannot emit `wav` cannot be used through this adapter.
Every implementation checked offers it — OpenAI's schema lists it, Kokoro-FastAPI's lists
it (`docs/SURFACE.md`, 2026-09-12) — but this is the constraint to remember when a user
reports a server that will not work. The fix, if one ever appears, is a decoder behind the
same `DecodedAudio` shape, not a change to what providers yield.

It also means **the adapter does not stream**. `stream_format: 'sse'` exists on OpenAI and
would deliver base64 deltas of a partial container; it is not used, because P1-T04 already
split the answer into sentences and the latency that matters is per sentence, not within
one. `capabilities().streaming` is `false` so nothing downstream is misled about it.

**Reconsider when:** a real endpoint appears that only speaks a compressed format, or when
a measurement shows intra-sentence streaming is worth the framing. Neither has happened.

## ADR-25 A model-ended turn is provisional until the backstop would have fired (accepted 2026-09-13, amended by P1-T08 the same day)

**Decision:** when Smart Turn ends a turn, `TurnDetector` emits `turn-end` at once — the
latency ADR-21 bought is untouched — but the end can still be **retracted** until
`hangoverMs` after speech stopped. Speech resuming inside that window (a frame at
`speechOn`) emits `turn-resumed`, cancels the recognition started on the ended candidate,
and continues the *same* turn with every frame heard so far. `turn-end` carries
`confirmedAt`, the moment the end becomes final: `speechEndAt + hangoverMs` for a model
end, and the end itself for a hangover end, which is never retracted.

**Why.** P1-T07's live check (`pnpm live:turn`, `docs/SURFACE.md`) had Kokoro speak
complete sentences with ~220 ms of real silence at phrase boundaries — "The afternoon light
│ came in low across the desk." Smart Turn scored the prefixes 0.79–0.96, because they
*are* finished-sounding utterances, and at Spike D's WebGPU latency the answer lands inside
the pause. **Four of six complete sentences were cut off**, and their transcripts were the
prefix. At node-wasm latency (~280 ms) the same answers arrived after speech had resumed
and were discarded, so **the faster the judge, the more it interrupts** — which is backwards
for a system whose whole point is speed.

Nothing in ADR-21 could take a premature end back. With this rule, the same run gives
**12 of 12 complete sentences ended at their end, 0 interrupted, 7 retractions, median
168 ms and worst 220 ms** to the end of the turn, and 0% word error on every kept window.

**Why this window and not a new constant.** `hangoverMs` is already the pipeline's
definition of "the person has stopped": a pause that ends before it would never have ended
the turn under the backstop alone. So retraction only ever undoes an end the old detector
would not have made, and adds no tuning dial. It also closes **500 ms after speech ends,
before ADR-21's ~553 ms first-audio path could play anything** — so a retracted turn costs
aborted work (a recognition pass, an LLM request, some synthesis), never audio the user
hears and the character has to take back.

**What it costs.** Consumers must treat a `model` end as provisional: start the work, but
be ready to abandon it on `turn-resumed`, and not write the turn to memory or the transcript
as final before `confirmedAt`. P1-T10's wiring and P1-T11's transcript inherit that. The
conversation machine's `user.turn.ended` has no retraction counterpart in `packages/protocol`
yet; adding one is an architect-owned protocol change for whichever task first wires the
detector into the machine.

**Alternatives rejected.** Raising the candidate silence past typical phrase pauses
(~250 ms) would stop most mid-sentence fires by giving back most of what ADR-21 won, and
still fail on a longer pause. Raising the threshold does nothing: the prefixes scored 0.96.

**Evidence limit.** Kokoro's pauses are synthetic. Spike D, on a human speaker, recorded at
most one extra turn in ~160 utterances, so how often a person triggers retraction is
unmeasured. The rule is right either way — it only acts when speech resumes inside the
backstop — but the first human measurement belongs to the first task that puts the
microphone in the app.

**Reconsider when:** a human measurement shows retraction firing often enough that the
abandoned work matters, or P1-T08's barge-in changes what the hangover means.

**Amended 2026-09-13 (P1-T08).** Three things this ADR left to later are done. The protocol
has its retraction event: `user.turn.resumed { pauseMs }`, with `thinking → listening` in
the transition table — needed because `TurnDetector` emits `turn-resumed` *instead of* a
second `speech-start`, so without it a machine in `thinking` never learns the user carried
on. `user.turn.ended.probability` became nullable at the same time: a hangover end with no
answer in time has no probability, and a made-up one would read as the model's. **"Never
audible" is now a guarantee rather than arithmetic**: `Reply` starts the model and the
synthesis at once but queues no audio before the turn's `confirmedAt`, and `VoiceSession`
releases the hold on the first frame past it. And the reconsider clause about barge-in
closes with nothing changed: barge-in acts on speech while the character is audible, which
is after `confirmedAt` by construction, so it never meets a retractable end and the
hangover means what it meant.

## ADR-26 Barge-in ducks first and commits on sustained speech (accepted 2026-09-13)

**Decision.** While the character is audible, the first speech frame (`speechOn`) **ducks**
the voice to −12 dB over 30 ms. The barge-in **commits** once `bargeInMs` of speech has been
heard — 200 ms, counting frames at or above `speechOff` — and then the reply is cancelled as
one (model, synthesis in flight, queued audio), the voice fades to zero over 100 ms, and
`assistant.interrupted` carries what was heard. Speech that stops for 100 ms before
committing **unducks** over 80 ms and the answer carries on. A turn that ends while the
character is still audible and nothing committed is ignored. `bargeInMs: 0` is the plan's
original rule — fade on the first speech frame — and stays one setting away.

**What "heard" means.** Every frame the worklet rendered up to the fade's **midpoint**. The
output latency delays those frames reaching the ear; it does not stop them arriving, so it
is not subtracted (P1-T08's brief said to subtract it, and was wrong). Without word
timings, a word counts once its character-proportional end, spread over the sentence's
voiced range, has rendered. `pnpm live:bargein` measured that against Moonshine on 52
cut-and-faded utterances: exact 18, one word behind 30, one word ahead 4 (two of them real,
both right after a comma pause), never two or more either way.

**Transitions that changed.** `speaking` no longer leaves on `user.speech.started` (speech
only ducks); it leaves on `assistant.interrupted`. It no longer returns to `listening` on
`assistant.audio.ended`, which is per sentence — P1-T01's table went back to listening while
the second sentence was still playing — but on `assistant.message`, the settled answer.
`interrupted → listening` follows the real fade: the machine asks `AudioOutPort.fadeOut` and
moves when its promise resolves.

**Why two stages.** Spike A's transcripts had the character's previous reply in them — the
microphone heard the speakers with echo cancellation on — and a cough or a "mm-hm" is
speech to Silero too. A fade on the first frame throws an answer away for any of those. A
duck is heard at once and costs nothing when it was wrong. In the browser harness 14
consecutive committed barge-ins and 13 ducks rendered no step larger than 1.12× the voice's
own in the 50 ms before, and every fade reached exact zero at 100 ms.

**What it costs.** Up to `bargeInMs` of the character talking over the user at −12 dB before
it stops, and a real interjection shorter than 200 ms of speech ("wait—") only ducks.

**Not measured when proposed.** Whether Chrome's echo cancellation removes this page's own
voice from a microphone next to speakers, which decides whether `bargeInMs` can shrink or
has to grow; and whether 200 ms feels right to a person. Both were `docs/TASKS.md` R-2.

**Accepted 2026-09-13 on R-2** (`docs/runs/R-2-voice-2026-09-13.md`), unchanged. By ear the
cut is "very fast" with no clicks, and the *Heard* column ended on the word Rick last heard.
**Echo did not reach the gate at all**: a 16 s answer through speakers with the microphone
live produced no duck, so on that machine AEC is complete and 200 ms is not holding back
echo — it stays for coughs and short noises, not for the speakers. A cough produced nothing
either (no duck), so **the duck-and-recover stage has never been heard by a person**; it is
built and tested, and the first real false start will be its evidence. `bargeInMs` stays
200; nothing in R-2 argues for moving it. One machine, one volume.

## ADR-27 Synthesised sentences are trimmed to their voice before they are queued (accepted 2026-09-13)

**Decision.** `Reply` trims every synthesised sentence to its voiced range — the first and
last samples at or above 0.02 — plus **50 ms in front and 250 ms behind**, before it reaches
the output queue. `padding: null` plays synthesis as delivered.

**Why.** Kokoro pads each sentence with ~310 ms of silence in front and ~490 ms behind, in
the browser and in node alike (`docs/SURFACE.md`). Untrimmed, the first word of every answer
reaches the listener a third of a second after the pipeline's "first audio" — latency the
user hears against a 500 ms budget (ADR-20) — and consecutive sentences sit ~0.8 s apart,
which reads as hesitation. Trimmed, they meet with ~300 ms between them.

**Why these numbers.** 50 ms in front because a soft onset ("f", "h") starts below the
voiced threshold and must not be clipped; 250 ms behind so the gap between two sentences
stays inside the range of a spoken pause. Both are starting values chosen by reasoning, not
by ear, which is why this was proposed until R-2 (below).

**Alternatives rejected.** Trimming to the threshold exactly (clips onsets); trimming only
the first sentence of an answer (wins the latency, keeps the 0.8 s gaps); asking kokoro-js
not to pad (1.2.1 has no such option).

**Accepted 2026-09-13 on R-2** (`docs/runs/R-2-voice-2026-09-13.md`), unchanged: by ear
the gaps between sentences "sound good", with no clipped onsets and no clicks at a sentence
start, and the output check found 0 clicks of 58 events over 176 s.

## ADR-28 Backchannels: words, in pauses judged unfinished, and a clip talked into ducks and finishes (accepted 2026-09-13)

**Decision (P1-T09).** `VoiceSession` takes an optional clip bank and a `BackchannelScheduler`
(`packages/core/src/backchannel`). A clip plays on Smart Turn's `judged` answer when the answer
is **under the turn threshold**, the conversation is `listening`, nothing is playing, the last
clip started **8 s** or more ago, and the turn has carried **3 s** of speech before the pause.
Clips are pre-synthesised once per voice, trimmed to their voice plus **50 ms either side**,
and the default set is **"Yeah." "Right." "Yes." "Oh."**, never the same one twice running.
A clip never *starts* over speech (`judged` exists only for a pause that is still silent). If
the user speaks while it plays — `speechOff` inside the turn, `speechOn` after it — the clip
is **ducked** to −12 dB and finishes, and the gain is restored when it ends. `overlap: 'cut'`
fades it out over 50 ms instead, which is the plan's literal "never over user speech".

**Protocol.** `assistant.backchannel { text }`, emitted when a clip is queued. It moves no
state, is no transcript line and is not memory; it exists so P2 can nod and P3 can count.
Additive: no `PROTOCOL_VERSION` bump.

**Why words.** Kokoro's phonemizer reads nonverbal spellings as letters: "Mm-hmm." is
/ˌɛmˈɛmhəm/, "Mhm." is /ˌɛmˌeɪtʃˈɛm/, and "Mm.", "Hmm.", "Uh-huh." fared no better
(`pnpm live:backchannel`, `docs/SURFACE.md`). Words phonemize as themselves, reach a TTS server
as plain text too, and the four chosen are the shortest that read as listening (351–503 ms
of voice on `af_heart`); "I see." and "Okay." run 524–624 ms.

**Why duck, not cut — the arithmetic, then the browser.** A clip starts ~210 ms into a pause
(100 ms candidate window, one 32 ms frame, a ~10 ms judge). A pause the turn survives is under
the 512 ms hangover, so a mid-turn clip has under ~300 ms before the user resumes, and every
word is longer. In the Browser pane (three runs of the harness's story, `docs/SURFACE.md`)
**every one of 5 clips started in a mid-turn pause was talked into before it finished**:
cut, "Oh." lost its last third and "Right." was faded 9 ms in — nothing of it heard. Ducked,
both played whole under the resumed speech. A word chopped in half sounds like a fault; a
quiet word finishing under the speaker is what listeners do. 0 clicks in either mode
(16 and 18 events, ducks and unducks included).

**Why these gates.** `judged` below threshold is the plan's rule and the only signal that the
floor is still the user's. **3 s of speech** because R-2 saw Smart Turn score a short,
complete question 0.01–0.02 three times of four: the hangover then ends the turn, and a
backchannel would land between the question and its answer. 8 s is the plan's number.

**What it costs, recorded rather than hidden.**
- **Smart Turn misses finished sentences, and a backchannel then precedes the answer.** The
  story's final sentence scored 0.05–0.06 in two of the three browser runs: "Yeah." played, the
  hangover ended the turn ~300 ms later, and the answer followed. `minSpeechMs` only guards
  short turns. The scheduler can be no better than the turn model it listens to.
- Ducked clips overlap the user's speech by up to ~350 ms at −12 dB — the reason this is not
  the plan's literal rule. If AEC is imperfect, that tail reaches the microphone while the
  user is talking.
- A clip queued when the hangover ends the turn sits ahead of the answer's first sentence.
  In the runs the answer started 790–1770 ms after the clip ended, so it cost nothing there.

**Not measured when proposed.** How any of it sounds: whether duck beats
cut to a person, whether 3 s and 8 s feel right, whether the words sound like listening or
like interruptions, and a real microphone with a person's own pauses, which are not Kokoro's.
`docs/TASKS.md` R-4, with a command.

**Accepted 2026-09-13 on R-4** (`docs/runs/R-4-backchannels-2026-09-13.md`), unchanged. With
Rick's own pauses on the microphone the rules held — 4 clips in ~65 s, 14–22 s apart, none
while the character answered — and by ear the words sounded right, "nothing sounded wrong",
and duck's "short cut-ins" beat cut. **Every clip started inside a turn was talked into**, as
the arithmetic said: 10 of 10 across P1-T09 and R-4, 11–255 ms after being queued. The cut
session played one clip, cut at 73 ms, so the comparison rests on duck's run and that blip;
what sounded like cut "talking longer" was the character's answers, which the setting does
not touch. A clip before the answer happened in 3 of the duck session's 7 clips and was heard
as "short words, then the full answer" — kept as a cost, not a fault. Nothing in R-4 argues for moving 3 s or 8 s,
and the microphone picked up nothing from the speakers. One person, one machine.

## ADR-29 Endpoints that refuse browser origins go through the companion's relay (accepted 2026-09-14)

**Decision (P1-T10).** Each endpoint carries a measured *browser access*: `direct` (it
answers CORS for the page), `local-cors` (a local server whose CORS the user turns on — the
settings page shows how), or `relay`. A `relay` endpoint is called through the companion's
`GET|POST /relay` on 127.0.0.1, naming the real URL in `x-lp-target`; the provider is given
`relayFetch` and does not know. Only **NVIDIA** is `relay` today.

**Why.** NVIDIA's `integrate.api.nvidia.com` sends no `Access-Control-Allow-Origin` on any
response or preflight (`docs/SURFACE.md`, 2026-09-14), so no page can read it — and the plan's
done-when names NVIDIA. Every earlier check ran in node, where CORS does not exist.

**The relay's limits, which are the point of it.** Targets are a compiled-in allowlist of
exact origins and a path prefix (`https://integrate.api.nvidia.com` + `/v1/`), so it cannot
reach the LAN or anything a page names. Pages are an allowlist too: localhost on any port,
`https://app.latentpresence.com`, the Tauri webview; any other `Origin` is refused before
anything is forwarded. It forwards `authorization`, `content-type` and `accept` only,
returns only the content type, follows no redirect (one would carry the key to an unlisted
host), holds no key, logs nothing. A page that aborts closes the upstream call.

**Keys.** The plan's "WebCrypto-encrypted in localStorage" needs a key somewhere: a
**non-extractable** AES-GCM key in IndexedDB, ciphertext in localStorage, a fresh IV per
write. It is stated on screen for what it is — it stops a copied profile or backup from
yielding keys, not code running in the page or someone using the profile. The OS keychain
arrives with Tauri (P8-T01).

**Alternatives rejected.**
- *A proxy on our server* — every NVIDIA key and conversation would pass through
  infrastructure we run, against "nothing leaves the user's machine unless they pointed it
  somewhere".
- *Vite's dev-server proxy* — works only under `pnpm dev`; the product would have no path.
- *Drop NVIDIA from the browser until the desktop app* — fails the plan's done-when, and the
  desktop app runs the companion anyway, so the relay is the same code there.
- *A general proxy the user configures* — an SSRF tool on every user's machine.

**What it costs.** NVIDIA needs the companion running (`pnpm companion` until P8 bundles it),
and a Rust HTTP client in the companion (`reqwest` 0.13, rustls). A new endpoint that refuses
browsers is a code change plus a SURFACE measurement, on purpose.

**Not measured when proposed.** Chrome's Local Network Access prompt from
the hosted app to the companion (the relay answers `Access-Control-Allow-Private-Network`;
P8-T03 verifies); Firefox and Safari; whether NVIDIA stops generating when the relay drops the
connection; and a person configuring Ollama and NVIDIA from the page without docs — R-5.

**Accepted 2026-09-14 on R-5**, unchanged. Rick configured both from `/settings` with no
docs: Ollama listed its models and replied (`nemotron-3-nano:30b-cloud` 0.4 s,
`qwen3.5:9b` 5.3 s); NVIDIA saved a key, connected through the companion (81 models) and
`meta/llama-3.2-11b-vision-instruct` replied in 0.2 s — so the relay carries a real key and a
real completion. **One gap, fixed (4777a54):** nothing on screen said how to start the
companion until a test had failed; the relay note now names `pnpm companion`. Still
unmeasured: Local Network Access from the hosted app (P8-T03), Firefox and Safari, and whether
NVIDIA stops generating when the relay drops a connection.

## ADR-30 The tag protocol (accepted 2026-09-21)

**Decision**, in four parts, all of which P1-T12 had to make explicitly because ADR-23
deferred them:

1. **The grammar stays `[emote:x]` and `[gesture:x]`**, exactly as `SentenceChunker` has
   parsed it since P1-T04.
2. **Gestures get a closed vocabulary**, `CharacterGestureSchema`: `nod, shake-head, shrug,
   wave, tilt-head, lean-in, open-hands, think`. `InlineTag.known` now reports a gesture
   against that list, where before it was always null for a gesture.
3. **Tags are carried on `assistant.sentence`**, as `tags: InlineTag[]`, additively, with a
   default of `[]`. **`PROTOCOL_VERSION` stays 1.**
4. **Tokens never carry a tag.** A `TagFilter` in core holds back any trailing text that
   could still become one, and `Reply` and `ChatSession` both stream through it.

**Amended 2026-09-21, on the first full `live:persona` run: `emotion` is accepted as a
spelling of `emote`** and normalised to it. `qwen3.5:9b` wrote `[emotion:concern]` on 12
of 20 turns. The failure mode is the reason this is a grammar change and not a prompt
change: **an unrecognised tag is not dropped, it stays in the spoken text**, so the
character would have said "emotion concern" out loud to the user. The parser is now
deliberately more forgiving than the prompt is instructive — the prompt teaches one
spelling, and accepting the single most likely near-miss costs one alternation. The tag
still normalises to `kind: 'emote'`, so nothing downstream sees a third kind. Not a
`PROTOCOL_VERSION` change: the wire shape is untouched.

**Why the grammar stays.** It is the cheapest thing a model can emit that survives
streaming. The pilot (`docs/SURFACE.md`) had a strong model follow it six times out of six
with no leaked markup. The alternatives each buy something we did not need: an XML-ish
`<emote>` costs more tokens for the same information; a JSON side channel cannot be
streamed and interleaved with speech at all; and tool calls would make every emotional beat
a round trip, which is latency in the one place ADR-20 has none to spare.

**Why gestures are closed and short.** Two constraints meet here. The whole list goes into
every system prompt, so a long one crowds out the persona and costs tokens on every turn.
And **P2-T03's clip library has to cover exactly these labels** — a label with no clip is a
gesture the character promises and cannot make. That makes the vocabulary partly an art
commitment, so it was Rick's call, taken 2026-09-21 on the eight the pilot produced.
Emotions were already closed for the same reason (`CharacterEmotion`, twelve labels mapped
to VRM presets by P2-T01), so this is the existing pattern, not a new one.

**Why `assistant.sentence` rather than a new `assistant.tag` event.** The sentence is the
unit P2-T07 schedules against: it already carries the index and the tag-free text, and a
tag's offset is an index into *that* text. A separate event would duplicate the sentence
index, and — worse — could arrive in a different order from the text it belongs to, so a
consumer would have to buffer and rejoin them. The one real cost is that a tag cannot be
delivered before its sentence settles, which nothing needs: P2 schedules against TTS word
timings that do not exist until synthesis has run anyway.

**Why `known` keeps the raw label beside the verdict.** A model invents labels. Dropping an
invented one silently would lose a gesture the avatar could still have approximated;
passing it through as valid would ask P2 to map something it has no clip for. So `value` is
always what the model wrote and `known` is null unless it is on its own kind's list. The
live check reports off-list labels by name rather than counting them as leaks, which is how
we will learn what the vocabulary is missing.

**Why tokens are filtered rather than left raw.** `docs/ui/transcript.md` named this as
P1-T12's to fix: before it, a viewer watched `[emote:joy]` appear in the streaming
transcript and vanish when the sentence settled. The filter shares the chunker's regex and
its 48-character scan limit by importing them, because two copies that drifted apart would
show up as text the transcript hides and the speech says, or the reverse.

**What it costs.** Every producer of `assistant.sentence` must now pass `tags` — the TypeScript
type requires it even though the wire format does not, which is deliberate: a producer that
forgets is a silent loss of every tag it had. And a partial tag at the end of a stream is held
back for one delta, so a transcript can lag the model by that much. Both were measured as
nothing: the held text is at most 48 characters and is released on the next delta or on flush.

**Not measured when accepted.** Whether models keep to the eight gestures in normal use
rather than in a scripted check (`pnpm live:persona` measures the scripted case);
whether `often` expressiveness produces gestures a viewer finds excessive, which needs
P2-T03's clips and eyes; and whether a second emote mid-reply lands where the feeling
actually changes, which needs the avatar to be visible.

**Amended 2026-09-23 by P2-T07 (architect-owned protocol change): `assistant.audio.started`
carries an optional `timing` (`SentenceTimingSchema`: `durationMs`, `voicedStartMs`,
`voicedEndMs`, optional `words`), in ms from the sentence's first played frame.** A tag's
offset says which word; only the audio knows when that word is, and the bus's `at` is a
dispatch time. Additive, optional, so `PROTOCOL_VERSION` stays 1 (this ADR's precedent).
`Reply` fills it from the audio it already holds; `trimToVoice` now reports its cut so
backend word timings are moved onto what plays. **Measured:** without word timings the
position is estimated by character over the voiced span, and on Kokoro that is |error|
median 133 ms, p90 281 ms against Whisper's word times (`pnpm live:cues`) — fine for the
start-of-sentence tags the prompt asks for, not for mid-sentence ones. P2-T09 carries the fix.

## ADR-31 Animation clips are converted in node, not retargeted in Blender (accepted 2026-09-24)

**Decision.** `pnpm clips:build` (`packages/avatar/tools/build-clips.ts` over
`src/clips/vrma.ts`) turns a glTF animation into a `.vrma` by relabelling the source's own
bones as VRM humanoid bones and dropping every channel the format does not allow. No
Blender, no VRM add-on and no retarget solve are in the pipeline. The built clips and a
manifest with licences are committed in `assets/clips/`; the source pack is not.

**Why this works.** `three-vrm-animation` retargets at load time by dividing every
rotation by the file's own rest pose, so a `.vrma` needs one property of its skeleton and
only one: **a rest pose that is VRM's T-pose facing +Z**. Quaternius's Universal Animation
Library already has one (measured 2026-09-23: arms level along ±X, legs straight, toes
towards +Z), so re-posing was never needed. `checkTPose` makes that an assertion the
build runs rather than an assumption: an A-pose or a −Z-facing source is refused.

**Why not Blender, which R-12 and the plan assumed.** It would put a 400 MB desktop
application and an add-on's Python API between a CC0 file and the repo, for a step that
turned out to be a filter. The node converter runs anywhere `pnpm` does, is deterministic
(an unchanged rebuild is byte-identical) and is tested against the real loader. Blender
and its MCP remain the tool for P7's character work.

**What would reverse it.** A clip source whose rest pose is not a T-pose (Mixamo's is not
exactly, and many packs are A-posed): then either the converter learns to re-pose the rest
(rotate each chain onto the T-pose axes and rebase the tracks), or that source goes
through Blender. Recommended option taken: node, with the reversal written down.

**Accepted 2026-09-24 by Rick**, on the condition that swapping or user-supplied avatars stay
functional — which this does not touch: a `.vrma` is retargeted onto whichever VRM loads it,
at load time, from that model's own humanoid rest pose. Only a new *clip* source can meet the
reversal above (an A-posed pack such as Mixamo's).
