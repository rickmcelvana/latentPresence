# PROJECT.md — latentPresence (living document)

> Load at the start of every session. Update at the end. Session-start rule: check this file against `git log` since the last session note; fix drift before new work.

## Snapshot

- **Project:** latentPresence, formerly latentAura (renamed 2026-09-07; aura.ai exists). Open-source (Apache-2.0) conversational AI with a full-body semi-realistic avatar in a video-call framing. Browser-first; optional Rust companion; MariaDB Vector memory; ships no models.
- **Domains:** `latentpresence.com` (site, docs, feedback) and `app.latentpresence.com` (the app), self-hosted behind Caddy. Rick sets up Caddy later.
- **Phase:** **0 — Foundations and spikes.** P0-T01, P0-T02, P0-T02b, P0-T03, P0-T04 and P0-T07 landed 2026-09-08; **P0-T05 and P0-T06 landed 2026-09-09**. ADR-16 amended, ADR-20 accepted, **ADR-21 accepted 2026-09-09** (turn detection counts inside the pipeline budget). 21 ADRs accepted.
- **Current task:** **P0-T08 Spike E** — Linux leg **done 2026-09-09, no-go for Tauri on Linux**. Open until the Windows/WebView2 column is filled in, which needs Rick back on Windows and is a run rather than a build.
- **Next task:** P0-T09, the Phase 0 retrospective. Every other Phase 0 task has landed.
- **Blockers:** none. No Docker anywhere, so CI uses a service container rather than a local one.
- **Default character:** Alice (name chosen 2026-09-07). Placeholder VRM until P7-T02.
- **Dev database (2026-09-09):** MariaDB **11.8.8** at `192.168.40.101` on the LAN, `DATABASE_URL` in `.env`, `ALL PRIVILEGES ON latentpresence.*`. `VECTOR(768)` with `VECTOR INDEX … DISTANCE=cosine` creates, inserts and answers top-k, and **`EXPLAIN` confirms the index is used rather than scanned**. RTT **p50 0.43 ms**. The earlier host `10.0.0.1` is 10.11.18 (no vectors) but gave the figure that matters: **p50 39.8 ms over the tunnel**, so retrieval must be one statement for any remote deployment. `docs/SURFACE.md`.
- **Toolchain:** TypeScript 7.0.2, Vite 8, Vitest 5, oxlint 1.81, React 19.2, Node 22, **pnpm 12.3.4** (was 11.24.0; pnpm 12 rewrites its own pin, so the bump was taken rather than fought — the Windows box needs pnpm 12 before its next install), axum 0.8. **rustc 1.98** on the Linux box, 1.97 on Windows. Verified facts in `docs/SURFACE.md`.
- **Test counts (2026-09-09):** 190 TypeScript, 17 Rust. `pnpm gate` green. CI was **red on main** from 97dc688 until 12d6da8 — rustc 1.98's new `chunks_exact_to_as_chunks` clippy lint, on a docs-only commit, on both runners.
- **Voice pipeline (Spike A, 2026-09-08):** 947 ms end of speech to first audio on WebGPU/fp32; 435 ms excluding the VAD hangover, against ADR-20's 500 ms pipeline budget. WebGPU is required — wasm synthesis is 3779 ms. q8 recognition is broken on WebGPU. Details in `docs/spikes/A-voice-loop.md`.
- **Turn detection (Spike D, 2026-09-08):** **Go.** Smart Turn v3 on fp32/WebGPU with a 100 ms candidate and a 0.7 threshold answers in **168 ms** against the 512 ms hangover it replaces, and interrupted 0 of 51 held pauses across the five runs after the first. int8 will not load on WebGPU at all (loudly) and is a no-GPU fallback. First audio becomes ~593 ms sequential, ~553 ms once recognition overlaps turn detection - which ADR-21 makes P1's job, against an unchanged 500 ms budget. `docs/spikes/D-smart-turn.md`.
- **Avatar (Spike B, done 2026-09-09):** **Go.** A full-body VRM 1.0 with MToon, spring bones and constraints runs at **120.5 fps median at 1916×1076** on an RTX 5060 Ti — the budgeted 1080p — and the worst frame of the run (15.0 ms) still fits inside 60 fps. Quadrupling the pixels moved neither the median nor the 5th percentile, so the scene is display-bound, not fill-rate bound. Lip sync reads as speech. **wawa-lipsync emits fifteen Oculus visemes, not VRM's five**; the mapping is in `packages/avatar` with tests. `docs/spikes/B-vrm-lipsync.md`.
- **Memory store (Spike C, done 2026-09-09):** **Go.** MariaDB 11.8.8 stores `VECTOR(768)` bit-exactly and answers a top-8 at **100k rows in 4.90 ms median, 8.47 ms p95** on the LAN, `EXPLAIN` naming the index at 10k and 100k. Against the 100 ms per-turn budget that is ~12x headroom locally; over the 39.8 ms tunnel one statement is 44 ms, two 86 ms, three 128 ms, so **ADR-17's one-call rule is confirmed with arithmetic**. `mhnsw_ef_search` is session-settable and at 320 the p95 is still 12 ms, so recall is an affordable dial — but recall itself is **not measurable from a random fixture** and belongs to P4. `docs/spikes/C-mariadb-vector.md`.
- **Server tuning is a shipping requirement, not a preference:** the stock `mhnsw_max_cache_size` is **16 MB** against 307 MB of vectors at 100k rows, which cost a **5x** query slowdown and made 100k unreachable. It is `GLOBAL`-only, so no application user can set it and the product cannot detect or fix it from inside. Whatever ships must document it.
- **Linux handoff (2026-09-09):** the repo is portable — `.gitattributes` forces `eol=lf`, no script is platform-specific, and **no LFS payload is actually committed**, so a plain `git pull && pnpm install` is enough. Spike E's risk is the webview, not the toolchain.
- **Desktop shell (Spike E, Linux leg 2026-09-09):** **No-go for Tauri on Linux.** `navigator.gpu` is **undefined** in WebKitGTK 2.52.5 — the JS bindings are not in the build, and the library ships the string `WebGPU platform is unsupported.` Spikes A, D and B all need WebGPU, so **Linux ships as companion + Chrome**, which is ADR-07's own fallback clause rather than a new decision (ADR-07 amended). The shell also **will not start on GNOME Wayland** with the NVIDIA driver — explicit-sync protocol error on first commit — and WebKitGTK's own MiniBrowser dies identically, so that one is the port, not Tauri. `GDK_BACKEND=x11` works. `docs/spikes/E-tauri.md`.
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

- [ ] **Back on Windows: run the Spike E shell** to fill in the WebView2 column. That is the only thing standing between P0-T08 and closed. In order:
  1. `npm i -g pnpm@12` — do this **first**. The repo pin moved to 12.3.4 and a global pnpm 11 will fight it on the next install.
  2. `git pull && pnpm install` — no LFS step; the Tauri icons are deliberately pinned out of LFS in `.gitattributes`.
  3. `pnpm dev` in one terminal, and leave it up. The shell points at that dev server.
  4. `cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml` in a second terminal, then run `apps\desktop\src-tauri\target\debug\latentpresence-desktop.exe` **from that terminal, not from Explorer** — the result prints to stdout and you need to be able to read it.
  5. In the window, click **"Spike E — webview capabilities"**. A markdown table prints to the terminal; paste it back. No `GDK_BACKEND` business — that was Linux.
  - **The WebView2 version records itself**: the probe prints `navigator.userAgent`, which carries the Chromium/Edge build. No registry key needed.
  - WebView2 is Chromium so the expectation is that it passes. Expectations are not results — Chrome on Linux was "obviously fine" too, and it wasn't.

- [ ] **On the Windows box, before its next `pnpm install`:** `npm i -g pnpm@12` (or enable corepack). The repo pin moved to **pnpm 12.3.4** on 2026-09-09 and a global pnpm 11 will fight it. CI needs nothing — `pnpm/action-setup@v6` reads the pin.

- [ ] Character pipeline (P7): wait for `docs/pipeline/character.md`; the architect writes exact instructions first. **Includes replacing `apps/desktop/src-tauri/icons/`, which is currently Tauri's scaffold logo** — committed so the Windows build works, not chosen.

## Backlog (architect)

- Port model discovery (Ollama `/api/tags` capabilities, LM Studio listing, cloud presets) from latentCreate `crates/llm-bridge` to TypeScript in P1-T02.
- Scheduled tasks (ADR-14) are P6-T07 and P6-T08; tray mode is P8-T05.

## Phase checklist

- [ ] P0 Foundations and spikes — T01, T02, T02b, T03, T04, T05, T06, T07 done; **only Spike E (T08) and the retrospective (T09) to go**
- [ ] P1 Conversation core
- [ ] P2 Avatar and stage v1
- [ ] P3 Affect engine and emotion sensing
- [ ] P4 Memory and MariaDB
- [ ] P5 Knowledge and tools
- [ ] P6 Presence, life and schedules
- [ ] P7 Character pipeline and realism (parallel)
- [ ] P8 Desktop and distribution (Windows first)
- [ ] P9 Polish and 1.0

## Last three sessions

- 2026-09-09 claude — **P0-T06 Spike C closed. Go**: top-8 at 100k rows in **4.90 ms median / 8.47 ms p95** on the LAN, `EXPLAIN` naming the index, storage bit-exact, CI running the schema against a real MariaDB. The finding was a default: a **16 MB** `mhnsw_max_cache_size` against 307 MB of vectors cost 5x on queries and made 100k unreachable. Two of my own measurement failures — a periodic fixture that let a probe collide with a stored row at distance 0.000000, and a whole run taken while the server installed a kernel — were caught and every number re-taken on an idle box.
- 2026-09-09 claude — P0-T05 Spike B closed on Rick's run: **570 frames, no misses at 120 Hz**, lip sync passes. Read as frame times it is a pass with unknown headroom, and it was taken at a quarter of the budgeted pixels, so a render-scale control was added and one 1080p reading is outstanding. Spike C unblocked by `.env`.
- 2026-09-09 claude — **P0-T08 Spike E, Linux leg. No-go for Tauri on Linux**: `navigator.gpu` is undefined in WebKitGTK 2.52.5 and the JS bindings are absent from the build, so ADR-07's own fallback clause fires and Linux ships as companion + Chrome. Two controls earned their keep — MiniBrowser dying byte-identically proved the Wayland crash is the port rather than Tauri, and the Chrome control found that Chrome has no WebGPU adapter on that box either. Also got main green: rustc 1.98's new clippy lint had CI red on a docs commit, on both runners, before this session started.

## Spike harness

Four dev-only routes in `apps/web`, all dropped from production builds by the guard in `vite.config.ts` (it fails the build if any reaches a chunk). `/spike/voice` is Spike A: consent, Silero + Moonshine + Kokoro, per-turn timing. `/spike/turn` is Spike D: the same capture and VAD with a short candidate silence, plus Smart Turn v3 and a labelled confusion matrix. `/spike/avatar` is Spike B: a VRM in react-three-fiber with lip sync and a frame-rate model. `/spike/shell` is Spike E: the webview capability probe, which prints a copyable markdown table and hands it to the Tauri host if there is one. Delete A and D at P0-T09 if Phase 1 has replaced them; **B's guard entries come out at P2-T01 deliberately**, because the avatar stops being dev-only there. E goes when P0-T08 closes.

The boot screen carries a **dev-only index of those routes**. It is not decoration: a Tauri window has no address bar, so without it the shell opens on `/` and no spike route is reachable from inside it at all.

## Quick links

Rules `CLAUDE.md` · Loop `docs/WORKFLOW.md` · Tasks `docs/LLM-PLAN.md` · Decisions `docs/DECISIONS.md` · Verified surfaces `docs/SURFACE.md` · Research `docs/RESEARCH.md` · Original brief `docs/brainstorm.md`
