# PROJECT.md — latentPresence (living document)

> Load at the start of every session. Update at the end. Session-start rule: check this file against `git log` since the last session note; fix drift before new work. **This is the current state only**: the per-task history it used to carry is in `docs/HISTORY.md` (moved 2026-10-17), the per-session record in `docs/SESSION-LOG.md`.

## Snapshot

- **Project:** latentPresence (formerly latentAura, renamed 2026-09-07). Open-source (Apache-2.0) conversational AI with a full-body avatar in a video-call framing. Browser-first; an optional Rust companion; MariaDB Vector memory; ships no models.
- **Where it runs:** the browser (`app.latentpresence.com`, **live** behind Caddy since 2026-10-16 — recipe in `docs/deploy.md`), the **Windows desktop app** (P8-T01: Tauri with the companion inside, per-user NSIS installer, unsigned), and a developer's checkout (`pnpm dev`, `pnpm companion`). **Linux ships as companion + Chrome** (no WebGPU in WebKitGTK, Spike E; ADR-07 amended).
- **The product site `latentpresence.com` left this repository on 2026-10-17** (Rick: `site/` deleted, kept locally in the git-ignored `latentpresence.com/`). ADR-16 said Caddy serves `<checkout>/site` — a `git pull` on the server removes it unless the server was moved too.
- **Phase:** **8 — Desktop and distribution, done 2026-10-19** (started 2026-10-16): **T01 done** (ADR-60 accepted, R-56 passed 2026-10-17: D-58); **T02 done** (first-run wizard, ADR-61; R-57 passed: D-59; the database address in the app, ADR-62); **T06 done** (the companion's own settings in the app, ADR-63; R-58 passed); **T03 done** (ADR-64; R-59 passed: D-61); **T05 done** (tray mode, ADR-65; D-62, D-63); **T04 done** (updates and releases, ADR-66; R-62 passed: D-64, v0.2.0 → v0.2.1 through the updater). **7** — T01 paused (image-to-vrm is a side project outside this repo), T02 done (avatar library and live swap, D-57). **6, 5, 4, 3: complete.** **2 and 1: every task done**, each with one check left — R-13's integrated-GPU half (P2) and **R-9, the five-minute conversation (P1's exit criterion)** — both in the laptop session.
- **Current task:** none in flight. **Phase 8 is done** (2026-10-19): the last check, R-62, passed — v0.2.0 updated itself to **v0.2.1** from Settings (D-64). Releases: a `v*` tag builds a signed draft (`docs/release.md`, about 30 minutes), Rick publishes it. The README is for people who find the repo (screenshots and the character-tools link to come from Rick).
- **Next task:** Rick: README screenshots and additions; then a separate repository for the Character Creator / Daz 3D → VRM converter (Rick's other project), linked from the README. Architect: **Phase 9** (polish and 1.0, P9-T01 first) or the laptop session. **Testers get the app from the [latest release](https://github.com/rickmcelvana/latentPresence/releases/latest)** (unsigned: SmartScreen's "More info → Run anyway"); installed copies update from Settings → This app.
- **Blockers:** none.
- **Characters (ADR-55, ADR-59):** Alice (default) and Theo, `personas/*.persona.json`; the persona id is the memory namespace. Both wear the pixiv placeholder by default; a person can wear their own `.vrm` per character, swapped live (`/chat` → Body). Open, Rick's call: a VRoid preset as Theo's default (terms allow it, SURFACE).
- **The desktop app (ADR-60):** the companion runs in the Tauri process on 8787 or a free port, paired by a per-launch token the page adds to every companion request; local Ollama and LM Studio go through its relay (Ollama 403s `http://tauri.localhost`); API keys in Windows Credential Manager; single instance, remembered window; closing hides to the tray (ADR-65). `pnpm desktop:build` → `apps/desktop/src-tauri/target/release/bundle/nsis/`. Icons from `apps/desktop/icon.svg` (`apps/desktop/README.md`).
- **The hosted app (`docs/deploy.md`):** Caddy with `try_files` and COOP `same-origin` + COEP **`credentialless`** (`require-corp` hid the OLLAMA_ORIGINS help — measured); the server needs Git LFS or the body's clips are pointer files. Visitors running Ollama set `OLLAMA_ORIGINS=https://app.latentpresence.com`; the browser asks before the site reaches their computer, and their companion wants its pairing code (ADR-64).
- **CI:** gate on ubuntu and windows (Windows also checks the desktop shell), `vector` (MariaDB), e2e. **After every push, read the run** (`gh run list --limit 1`): a green local gate is not a green CI.
- **Test counts (2026-10-19):** **2108** TypeScript passing (20 skipped: need a running companion or a model), **171** Rust; `pnpm gate` green.
- **Dev database:** MariaDB 11.8.8 at `192.168.40.101` (LAN), `DATABASE_URL` in `.env`. Over a tunnel a statement costs ~40 ms, so retrieval stays one statement (ADR-17). **Shipping requirement:** `mhnsw_max_cache_size` defaults to 16 MB, a 5× slowdown at 100k vectors, and is `GLOBAL`-only — whoever runs MariaDB must raise it (Spike C).
- **Toolchain:** TypeScript 7.0.2, Vite 8, Vitest 5, oxlint 1.81, React 19.2, Node 22, pnpm 12.3.4; three 0.185.1, three-vrm 3.5.5; kokoro-js 1.2.1; axum 0.8, sqlx 0.9, zip 9.0.3; tauri 2.12.4; rustc 1.97 (Windows), 1.98 (Linux). Verified facts in `docs/SURFACE.md`.
- **Lanes:** `main` (the architect), `sub` (a subagent run in-session, for work the brief and the repo alone get right) or `human`. The Aider lane is retired (2026-09-13). `docs/WORKFLOW.md`.
- **Known, unowned:** Smart Turn scores some complete questions under 0.7 (five instances; the hangover catches them); Spike D's int8 CPU Smart Turn is not wired, so a browser without WebGPU has no spoken conversation (refused in a sentence); time-bound facts do not expire (`docs/memory.md`). rustc 1.97.1 hit internal compiler errors twice in release builds (gone on retry).
- **~500 MB of models sit in `node_modules/.pnpm/@huggingface+transformers@3.8.1/.../.cache`** from the live checks; `pnpm install --force` costs that download again.

## Tasks needing a human or a live endpoint

In `docs/TASKS.md`, each with the command that runs it. **Open for Rick:** the **laptop session** (R-13: stage frame rate on an integrated GPU, R-1: the bare-avatar reading on the same GPU, R-9: the five-minute conversation, Phase 1's exit criterion). Done: R-2, R-4 to R-8, R-10 to R-12, R-14 to R-43, R-55 to R-62 (D-17–D-64); R-3 withdrawn. **One for the architect, needs Ollama running:** C-7, proving an aborted answer stops the model server-side.

## Backlog (architect)

- **Tool-only schedules from her tools** (ADR-58 left it out): `Schedule.toolCall` jobs run on the companion with the app closed (ADR-57), but `schedule_create` cannot make one yet — it needs her MCP tool names mapped to the companion's server ids. Wanted for "turn the grow light on at 7 every morning".
- **Time-bound facts do not expire** ("visiting next weekend" stays current; `docs/memory.md`).

## Phase checklist

- [x] **P0 Foundations and spikes** — complete 2026-09-11.
- [~] **P1 Conversation core** — every task done 2026-09-22; the exit criterion is **R-9**, a five-minute unscripted voice conversation (laptop session).
- [~] **P2 Avatar and stage v1** — every task done; R-13's integrated-GPU half open (laptop session).
- [x] **P3 Affect engine and emotion sensing** — every task done 2026-09-27.
- [x] **P4 Memory and MariaDB** — every task done; R-27 passed 2026-10-13.
- [x] **P5 Knowledge and tools** — complete 2026-10-12 (R-31, R-32, R-34).
- [x] **P6 Presence, life and schedules** — complete 2026-10-14 (R-43).
- [~] **P7 Character pipeline and realism** — T01 paused (image-to-vrm outside this repo); T02 done (D-57); T03–T05 not started.
- [~] **P8 Desktop and distribution (Windows first)** — started 2026-10-16; T01 done 2026-10-17 (ADR-60, D-58).
- [ ] **P9 Polish and 1.0**

## Last three sessions

- 2026-10-19 claude — **Measure the gate before writing the copy for it.** The plan said Chrome asks with a Private Network preflight; Chrome 155 and Firefox 154, driven in throwaway profiles, send none and ask the person instead — and a request waiting on that question, or refused by it, looks exactly like a companion that is not running. The page now asks the permission after a failure. A Chrome flag that puts a local build in the public address space let the whole hosted flow, pairing included, run before deploying.

- 2026-10-19 claude (2) — **A test binary is a binary too.** The tray's menu needs Common Controls 6, declared in a manifest tauri-build embeds in the app's exe only; the shell's unit tests died before `main` with a code that names no file. The manifest now goes through the linker to every target. And a size read as outer but set as inner grew the window by its frame on each round trip — two round trips in the live check showed it, one would not have.

- 2026-10-19/20 claude — **Prove the updater with a forged update before trusting a real one.** A separately named test build with a throwaway key updated itself from a local `latest.json`, and a forged entry carrying another file's genuine signature was refused — so when Rick's v0.2.0 found v0.2.1, the only new thing being tested was GitHub. It passed first time: Phase 8 is done.

## Dev-only routes

`/dev/avatar` (the renderer's debug panel; loads a local `.vrm`), `/dev/voice` (the voice pipeline with a scripted model — the only instrument for a speaker with no microphone, a timed barge-in and click analysis), `/dev/e2e` (Playwright's), `/spike/avatar` (R-1's frame-rate instrument). Spike E's `/spike/shell` was removed 2026-10-17. All are dropped from production builds by the guard in `vite.config.ts`. Their history is in `docs/HISTORY.md`.

## Quick links

Rules `CLAUDE.md` · Loop `docs/WORKFLOW.md` · Tasks `docs/LLM-PLAN.md` · Rick's checks `docs/TASKS.md` · Decisions `docs/DECISIONS.md` · Verified surfaces `docs/SURFACE.md` · Deploy `docs/deploy.md` · Research `docs/RESEARCH.md` · History `docs/HISTORY.md`
