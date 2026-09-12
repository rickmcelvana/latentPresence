# PROJECT.md — latentPresence (living document)

> Load at the start of every session. Update at the end. Session-start rule: check this file against `git log` since the last session note; fix drift before new work.

## Snapshot

- **Project:** latentPresence, formerly latentAura (renamed 2026-09-07; aura.ai exists). Open-source (Apache-2.0) conversational AI with a full-body semi-realistic avatar in a video-call framing. Browser-first; optional Rust companion; MariaDB Vector memory; ships no models.
- **Domains:** `latentpresence.com` (site, docs, feedback) and `app.latentpresence.com` (the app), self-hosted behind Caddy. Rick sets up Caddy later.
- **Phase:** **1 — Conversation core.** Phase 0 closed 2026-09-11 by P0-T09: every ADR checked against every measured result, every spike write-up linked from `docs/DECISIONS.md`. 21 ADRs accepted; ADR-01, 03, 05, 06, 07, 11, 17 and 20 carry measurement amendments.
- **Current task:** **P1-T01 conversation state machine** — `packages/core/conversation`, explicit states and a typed event bus, no DOM and no audio APIs. Nothing blocks it.
- **Next task:** P1-T02, the OpenAI-compatible LLM provider and model discovery, porting the verified shapes from latentCreate `crates/llm-bridge` rather than re-deriving them.
- **Blockers:** none. No Docker anywhere, so CI uses a service container rather than a local one.
- **Default character:** Alice (name chosen 2026-09-07). Placeholder VRM until P7-T02.
- **Dev database (2026-09-09):** MariaDB **11.8.8** at `192.168.40.101` on the LAN, `DATABASE_URL` in `.env`, `ALL PRIVILEGES ON latentpresence.*`. `VECTOR(768)` with `VECTOR INDEX … DISTANCE=cosine` creates, inserts and answers top-k, and **`EXPLAIN` confirms the index is used rather than scanned**. RTT **p50 0.43 ms**. The earlier host `10.0.0.1` is 10.11.18 (no vectors) but gave the figure that matters: **p50 39.8 ms over the tunnel**, so retrieval must be one statement for any remote deployment. `docs/SURFACE.md`.
- **Toolchain:** TypeScript 7.0.2, Vite 8, Vitest 5, oxlint 1.81, React 19.2, Node 22, **pnpm 12.3.4** (was 11.24.0; pnpm 12 rewrites its own pin, so the bump was taken rather than fought — the Windows box needs pnpm 12 before its next install), axum 0.8. **rustc 1.98** on the Linux box, 1.97 on Windows. Verified facts in `docs/SURFACE.md`.
- **Test counts (2026-09-11):** 190 TypeScript, 17 Rust. `pnpm gate` green. CI was **red on main** from 97dc688 until 12d6da8 — rustc 1.98's new `chunks_exact_to_as_chunks` clippy lint, on a docs-only commit, on both runners.
- **Voice pipeline (Spike A, 2026-09-08):** 947 ms end of speech to first audio on WebGPU/fp32; 435 ms excluding the VAD hangover, against ADR-20's 500 ms pipeline budget. WebGPU is required — wasm synthesis is 3779 ms. q8 recognition is broken on WebGPU. Details in `docs/spikes/A-voice-loop.md`.
- **Turn detection (Spike D, 2026-09-08):** **Go.** Smart Turn v3 on fp32/WebGPU with a 100 ms candidate and a 0.7 threshold answers in **168 ms** against the 512 ms hangover it replaces, and interrupted 0 of 51 held pauses across the five runs after the first. int8 will not load on WebGPU at all (loudly) and is a no-GPU fallback. First audio becomes ~593 ms sequential, ~553 ms once recognition overlaps turn detection - which ADR-21 makes P1's job, against an unchanged 500 ms budget. `docs/spikes/D-smart-turn.md`.
- **Avatar (Spike B, done 2026-09-09):** **Go.** A full-body VRM 1.0 with MToon, spring bones and constraints runs at **120.5 fps median at 1916×1076** on an RTX 5060 Ti — the budgeted 1080p — and the worst frame of the run (15.0 ms) still fits inside 60 fps. Quadrupling the pixels moved neither the median nor the 5th percentile, so the scene is display-bound, not fill-rate bound. Lip sync reads as speech. **wawa-lipsync emits fifteen Oculus visemes, not VRM's five**; the mapping is in `packages/avatar` with tests. `docs/spikes/B-vrm-lipsync.md`.
- **Memory store (Spike C, done 2026-09-09):** **Go.** MariaDB 11.8.8 stores `VECTOR(768)` bit-exactly and answers a top-8 at **100k rows in 4.90 ms median, 8.47 ms p95** on the LAN, `EXPLAIN` naming the index at 10k and 100k. Against the 100 ms per-turn budget that is ~12x headroom locally; over the 39.8 ms tunnel one statement is 44 ms, two 86 ms, three 128 ms, so **ADR-17's one-call rule is confirmed with arithmetic**. `mhnsw_ef_search` is session-settable and at 320 the p95 is still 12 ms, so recall is an affordable dial — but recall itself is **not measurable from a random fixture** and belongs to P4. `docs/spikes/C-mariadb-vector.md`.
- **Server tuning is a shipping requirement, not a preference:** the stock `mhnsw_max_cache_size` is **16 MB** against 307 MB of vectors at 100k rows, which cost a **5x** query slowdown and made 100k unreachable. It is `GLOBAL`-only, so no application user can set it and the product cannot detect or fix it from inside. Whatever ships must document it.
- **Linux handoff (2026-09-09):** the repo is portable — `.gitattributes` forces `eol=lf`, no script is platform-specific, and **no LFS payload is actually committed**, so a plain `git pull && pnpm install` is enough. Spike E's risk is the webview, not the toolchain.
- **Desktop shell (Spike E, Linux leg 2026-09-09):** **No-go for Tauri on Linux.** `navigator.gpu` is **undefined** in WebKitGTK 2.52.5 — the JS bindings are not in the build, and the library ships the string `WebGPU platform is unsupported.` Spikes A, D and B all need WebGPU, so **Linux ships as companion + Chrome**, which is ADR-07's own fallback clause rather than a new decision (ADR-07 amended). The shell also **will not start on GNOME Wayland** with the NVIDIA driver — explicit-sync protocol error on first commit — and WebKitGTK's own MiniBrowser dies identically, so that one is the port, not Tauri. `GDK_BACKEND=x11` works. `docs/spikes/E-tauri.md`.
- **Desktop shell (Spike E, Windows leg 2026-09-11):** **Go.** WebView2 **152.0.4191.66** gives a real WebGPU adapter (`nvidia / blackwell` — the probe rejects software rasterisers, so it means it), a live microphone, AudioWorklet, WebGL 2 on the discrete card, and a tray. ADR-07's Windows-first path is confirmed as written. **The microphone is the sharpest contrast with Linux**: same wry, `NotAllowedError` there and a stream here, so wry's permission handling is platform-specific — P8-T02 inherits that. `SharedArrayBuffer` is NO in all four containers measured, which locates it in the Vite dev server (no COOP/COEP) and means **Spike A's 3779 ms wasm figure was single-threaded** — now a P1 question, since wasm is the shipping path on Linux. **Windows notifications need an installed app**: the Rust call returns `Ok` and draws nothing from a dev binary, because Windows routes toasts by AppUserModelID and only a Start Menu shortcut supplies one — 82 apps registered on that box, zero for us. **P8-T01's NSIS installer is the fix and P8-T05 cannot be tested from `cargo run`.** The icons are now generated from `site/img/presence_512x512.png` rather than Tauri's scaffold logo, so no third-party asset is vendored and the `NOTICE` obligation is gone.
- **The Linux fallback is not free, and that is Phase 8's problem to inherit:** Chrome 153 on that box gave **no WebGPU adapter as launched** — its GPU sandbox could not read the Vulkan ICDs, though `vulkaninfo` sees the RTX 5060 Ti fine. `--disable-gpu-sandbox` gives `nvidia / blackwell`; `--enable-unsafe-webgpu` gives **`google / swiftshader`**, software, which passes a naive check and would silently miss every budget. One box, one distro, one very new driver — enough to decide Tauri-vs-Chrome, not enough to characterise Chrome on Linux.
- **The desktop crate is not gated, on purpose:** `apps/desktop/src-tauri` is its own cargo workspace and `pnpm gate` does not touch it. `pnpm gate:desktop` checks it on demand. Gating it would put tauri/wry/tao/webkit2gtk on every gate on every machine and need `libwebkit2gtk-4.1-dev` on CI's ubuntu runner, for a crate Phase 8 owns. **P8 should reverse this.**
- **Live:** `latentpresence.com` serves the site, docs and feedback form; a submission was confirmed end to end on 2026-09-08. Deploy is `git pull` + `pnpm build` on the server (ADR-16). `app.latentpresence.com` has no build behind it yet.

## Rick's backlog (things only Rick can do)

- [ ✅ ] Add `presence` to `normalize_source` in `tools/feedback-api` and proxy `latentpresence.com/api/feedback` in Caddy (needed by P0-T03).
Done.

- [ ✅ ] Caddy sites for `latentpresence.com` (serves `site/`) and `app.latentpresence.com` (serves `apps/web/dist`).
Done. Deploying by `git pull` on the server, so the rsync script P0-T03 wrote was deleted and ADR-16 amended.

- [ ✅ ] Confirm the tunnel to `10.0.0.1:3306` is up from the dev box before Spike C, and that MariaDB there is 11.8+ (`SELECT VERSION();`). If older, upgrade or Spike C uses the docker compose file.
Done.

- [ ✅ ] **Click-through of `/gallery`** (P0-T02b sign-off): `pnpm dev`, then http://localhost:5173/gallery. Tab through it — every interactive element must show the teal focus ring, nothing may look unstyled, and the drawer must close on Escape and on the scrim.
Done.

- [ ✅ ] **Run `/spike/turn`** (P0-T07 go/no-go). Done — eight runs, 2026-09-08. Go on fp32/WebGPU at 100 ms / 0.7.

- [ ✅ ] **Decide ADR-21**: turn detection counts inside ADR-20's 500 ms pipeline budget, and the budget stays at 500 rather than being restated to fit the measured 553 ms.
Accepted 2026-09-09. Followed through in DECISIONS, PLAN, RESEARCH, LLM-PLAN and the spike write-up.

- [ ✅ ] **Run `/spike/avatar`** (P0-T05). Done 2026-09-09 — 120.5 fps median, no dropped frame in 570, lip sync passes from mic and from a file. No integrated GPU on that board, so the GPU-preference comparison could not be run at all.

- [ ✅ ] **The 1080p reading.** Done 2026-09-09 — 1916×1076, 120.5 fps median, unchanged from 540p.

- [ ] Whenever hardware allows: the same page on **a different class of GPU** — a laptop, or anything with integrated graphics. Not urgent; the current card is well above "mid-range", so the interesting number is a worse machine, not this one.

- [ ✅ ] `.env` now carries `DATABASE_URL`. Done — and it revealed the item below.

- [ ✅ ] **A MariaDB 11.7+ for Spike C.** Done 2026-09-09 — Rick pointed `.env` at `192.168.40.101`, which is **11.8.8** and does everything the task needs. The old `10.0.0.1` (10.11.18) has no vector support; its 40 ms round trip is kept in the write-up as the remote-deployment figure.

- [ ✅ ] **Raise the MariaDB vector settings.** Done 2026-09-09 — `mhnsw_max_cache_size` 2 GiB, `innodb_buffer_pool_size` 4 GiB on the 16 GB box, and the update agent that polluted the first benchmark moved off it. That change is the whole finding of Spike C.

- [ ✅ ] **Before the Linux session:** the Tauri prerequisites. Done — verified 2026-09-09 on Fedora 44: `webkit2gtk4.1-devel` **2.52.5**, plus gtk3, libappindicator-gtk3, librsvg2, openssl and libxdo devel packages all present. `wget` is absent and stays absent; Tauri lists it only to fetch things and `curl` is there. Rust is Fedora's system **1.98.0** with no rustup, Node **22.23.2** via nvm.

- [ ✅ ] **Back on Windows: run the Spike E shell.** Done 2026-09-11 — **go on WebView2 152.0.4191.66.** Real WebGPU adapter (`nvidia / blackwell`), live microphone, AudioWorklet, WebGL 2, tray. The handoff's five steps were exact and only two were needed: neither `pnpm install` nor the Tauri CLI turned out to be required, because the binary runs directly and `apps/web`'s dependencies had not changed. The closing warning earned its place — WebView2 did pass, but the run still found a real trap (the notification ACL) that "obviously fine" would have hidden.

- [ ✅ ] **One tray click on Windows.** Done 2026-09-11, and it found something: the call returns `Ok` and **no toast is drawn**. Not a bug — Windows routes toasts by AppUserModelID, which an app gets from a Start Menu shortcut, and a binary run out of `target/debug/` has none. The registry confirms it: 82 apps registered for notifications on that box, zero entries matching `latentpresence`, and toasts not disabled globally. **P8-T01's installer is what fixes this, and P8-T05 must not be tested from `cargo run`.**

- [ ✅ ] **On the Windows box, before its next `pnpm install`:** `npm i -g pnpm@12`. Done 2026-09-11.

- [ ] Character pipeline (P7): wait for `docs/pipeline/character.md`; the architect writes exact instructions first. **Includes replacing `apps/desktop/src-tauri/icons/`, which is currently Tauri's scaffold logo** — committed so the Windows build works, not chosen.

## Backlog (architect)

- Port model discovery (Ollama `/api/tags` capabilities, LM Studio listing, cloud presets) from latentCreate `crates/llm-bridge` to TypeScript in P1-T02.
- Scheduled tasks (ADR-14) are P6-T07 and P6-T08; tray mode is P8-T05.

## Phase checklist

- [x] **P0 Foundations and spikes — complete 2026-09-11.** All five spikes measured, all four go/no-go calls made, ADRs reconciled with the evidence in P0-T09
- [ ] **P1 Conversation core — current**
- [ ] P2 Avatar and stage v1
- [ ] P3 Affect engine and emotion sensing
- [ ] P4 Memory and MariaDB
- [ ] P5 Knowledge and tools
- [ ] P6 Presence, life and schedules
- [ ] P7 Character pipeline and realism (parallel)
- [ ] P8 Desktop and distribution (Windows first)
- [ ] P9 Polish and 1.0

## Last three sessions

- 2026-09-11 claude — **P0-T09, the Phase 0 retrospective. Phase 0 is closed.** Read all 21 ADRs against all five spike write-ups. **One outright contradiction** (ADR-07 still said Windows was unmeasured and the spike open) and five ADRs that said less than the evidence supported. The two that matter beyond bookkeeping: ADR-05 now carries the `mhnsw_max_cache_size` shipping requirement, which was a real constraint with no decision record; and ADR-20 records that its 3779 ms wasm figure was taken **single-threaded**, which went from a footnote to a live question the moment ADR-07's Linux clause made Chrome a shipping path. Every spike doc is now linked from `docs/DECISIONS.md`. No ADR was reversed and no new decision was needed.

- 2026-09-11 claude — **P0-T08 Spike E, Windows leg. Go on WebView2**, and the spike is effectively closed. Started on a stale clone and built a whole parallel implementation of the same task before discovering `origin/main` was four commits ahead; reset to the published history, kept the duplicate on `spike-e-windows-leg`, and ported only the additive parts — a tray and the Rust notification path into the existing shell, and the surface corrections. Two facts survived from the discarded branch: `tauri` 2.11.5 resolves **wry 0.55.1**, not crates.io's 0.57.0 (confirmed against both lockfiles, so it is Tauri's pin), and `tauri-plugin-notification` polyfills `window.Notification`, so a page with no Tauri code in it is refused by the ACL — latent in the probe, but P8-T05 would have hit it.

- 2026-09-09 claude — **P0-T06 Spike C closed. Go**: top-8 at 100k rows in **4.90 ms median / 8.47 ms p95** on the LAN, `EXPLAIN` naming the index, storage bit-exact, CI running the schema against a real MariaDB. The finding was a default: a **16 MB** `mhnsw_max_cache_size` against 307 MB of vectors cost 5x on queries and made 100k unreachable. Two of my own measurement failures — a periodic fixture that let a probe collide with a stored row at distance 0.000000, and a whole run taken while the server installed a kernel — were caught and every number re-taken on an idle box.

## Spike harness

Four dev-only routes in `apps/web`, all dropped from production builds by the guard in `vite.config.ts` (it fails the build if any reaches a chunk). `/spike/voice` is Spike A: consent, Silero + Moonshine + Kokoro, per-turn timing. `/spike/turn` is Spike D: the same capture and VAD with a short candidate silence, plus Smart Turn v3 and a labelled confusion matrix. `/spike/avatar` is Spike B: a VRM in react-three-fiber with lip sync and a frame-rate model. `/spike/shell` is Spike E: the webview capability probe, which prints a copyable markdown table and hands it to the Tauri host if there is one. **Reviewed at P0-T09 (2026-09-11) and all four kept, each with a named trigger for deletion.** A and D were to go at P0-T09 "if Phase 1 has replaced them" — Phase 1 has not started, and they are the reference measurements P1-T06 and P1-T07 will be checked against, so they go when those land. B's guard entries come out at **P2-T01**, deliberately, because the avatar stops being dev-only there. **E was to go when P0-T08 closed, and is kept instead**: Phase 8 inherits two claims this spike deliberately left unverified — that an installed Windows build actually draws a toast, and what Chrome on Linux does for WebGPU without `--disable-gpu-sandbox` — and the probe is the instrument for both. It is dev-only, guarded and tested, so it costs a build assertion and nothing else. **It goes when P8-T01 closes.**

The boot screen carries a **dev-only index of those routes**. It is not decoration: a Tauri window has no address bar, so without it the shell opens on `/` and no spike route is reachable from inside it at all.

## Quick links

Rules `CLAUDE.md` · Loop `docs/WORKFLOW.md` · Tasks `docs/LLM-PLAN.md` · Decisions `docs/DECISIONS.md` · Verified surfaces `docs/SURFACE.md` · Research `docs/RESEARCH.md` · Original brief `docs/brainstorm.md`
