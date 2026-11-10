# PROJECT.md — latentPresence (living document)

> Load at the start of every session. Update at the end. Session-start rule: check this file against `git log` since the last session note; fix drift before new work. **This is the current state only**: the per-task history it used to carry is in `docs/HISTORY.md` (moved 2026-10-17), the per-session record in `docs/SESSION-LOG.md`.

## Snapshot

- **Project:** latentPresence (formerly latentAura, renamed 2026-09-07). Open-source (Apache-2.0) conversational AI with a full-body avatar in a video-call framing. Browser-first; an optional Rust companion; MariaDB Vector memory; ships no models.
- **Where it runs:** the browser (`app.latentpresence.com`, **live** behind Caddy since 2026-10-16 — recipe in `docs/deploy.md`), the **Windows desktop app** (P8-T01: Tauri with the companion inside, per-user NSIS installer, unsigned), and a developer's checkout (`pnpm dev`, `pnpm companion`). **Linux ships as companion + Chrome** (no WebGPU in WebKitGTK, Spike E; ADR-07 amended); measured end to end on Debian 13.7 (R-71 passed 2026-11-10, D-75: hardware WebGPU in Chrome as launched).
- **The product site `latentpresence.com` left this repository on 2026-10-17** (Rick: `site/` deleted, now its own repository, `rickmcelvana/latentpresence.com`, branch `master`, at `Z:\dev\latent\latentpresence.com` on this PC). ADR-16 said Caddy serves `<checkout>/site` — a `git pull` on the server removes it unless the server was moved too.
- **Phase:** **1.0 shipped 2026-11-05** (`v1.0.0`, ADR-71). Since then, on `main` and **in no release yet**: **Phase 10, Plugins — done 2026-11-10** (ADR-72, ADR-73; Tarot and Office, the index on latentpresence.com, `docs/plugins.md`; R-70 passed, D-76: a friend's Wheel of the Year from the guide alone) and **Phase 11, Characters people make — exit criterion met 2026-11-10** (ADR-74; the editor, the fixed AI disclosure, forgetting, export and import, `docs/characters.md`; R-72 passed, D-77); P11-T06 (a plugin offers a character) waits for tester feedback. Phases 0, 3–6, 8 and 9 complete; 1 and 2 done but for the laptop session (R-9, R-13); 7 has T02 done and the rest paused or not started. The per-task detail is in `docs/HISTORY.md` and `docs/LLM-PLAN.md`.
- **Current task:** **1.1.0 prepared** (version, notes in `docs/releases/v1.1.0.md`, README; Wheel of the Year in `plugins/`). In order: Rick pushes; the architect writes Wheel of the Year's index entry from the pushed commit and lists it on the site; Rick pushes the site; then Rick tags `v1.1.0` (`docs/release.md`). Office's morning plan errored once while Rick was away (perhaps a small model): Rick reports the next firing.
- **Next task:** after 1.1, deploy the hosted app from `main` (`docs/deploy.md`). Then: P11-T06 after tester feedback, P7-T03 (Set v2). Rick: the laptop session (R-9, R-13). **Testers get the app from the [latest release](https://github.com/rickmcelvana/latentPresence/releases/latest)** (unsigned: SmartScreen's "More info → Run anyway"); installed copies update from Settings → This app.
- **Blockers:** none. `.env` is back on this PC (2026-11-08); `sqlx-cli` is not installed, so the `.sqlx` cache cannot be refreshed here yet.
- **Characters (ADR-55, ADR-59, ADR-74):** Alice (default) and Theo, `personas/*.persona.json`, plus the person's own, kept in the browser's IndexedDB with fixed `u-` ids; the id is the memory namespace. Alice wears the pixiv placeholder by default and Theo a VRoid Studio model (`assets/bodies/theo.vrm`, ADR-59 amended); a person can wear their own `.vrm` per character, swapped live (`/chat` → Body).
- **The desktop app (ADR-60):** the companion runs in the Tauri process on 8787 or a free port, paired by a per-launch token the page adds to every companion request; local Ollama and LM Studio go through its relay (Ollama 403s `http://tauri.localhost`); API keys in Windows Credential Manager; single instance, remembered window; closing hides to the tray (ADR-65). `pnpm desktop:build` → `apps/desktop/src-tauri/target/release/bundle/nsis/`. Icons from `apps/desktop/icon.svg` (`apps/desktop/README.md`).
- **The hosted app (`docs/deploy.md`):** Caddy with `try_files` and COOP `same-origin` + COEP **`credentialless`** (`require-corp` hid the OLLAMA_ORIGINS help — measured); the server needs Git LFS or the body's clips are pointer files. Visitors running Ollama set `OLLAMA_ORIGINS=https://app.latentpresence.com`; the browser asks before the site reaches their computer, and their companion wants its pairing code (ADR-64).
- **CI:** gate on ubuntu and windows (Windows also checks the desktop shell), `vector` (MariaDB), e2e; `audit` weekly (npm and both Rust lockfiles, ADR-69), `release` on a `v*` tag. **After every push, read the run** (`gh run list --limit 1`): a green local gate is not a green CI.
- **Test counts (2026-11-10):** about **2423** TypeScript passing (20 skipped: need a running companion or a model), **193** Rust; `pnpm gate` green.
- **Dev database:** MariaDB 11.8.8 at `192.168.40.101` (LAN), `DATABASE_URL` in `.env`. Over a tunnel a statement costs ~40 ms, so retrieval stays one statement (ADR-17). **Shipping requirement:** `mhnsw_max_cache_size` defaults to 16 MB, a 5× slowdown at 100k vectors, and is `GLOBAL`-only — whoever runs MariaDB must raise it (Spike C).
- **Toolchain:** TypeScript 7.0.2, Vite 8, Vitest 5, oxlint 1.81, React 19.2, Node 22 (CI; 26.13 on this PC), pnpm 12.3.4; three 0.185.1, three-vrm 3.5.5; kokoro-js 1.2.1; axum 0.8, sqlx 0.9, zip 9.0.3; tauri 2.12.4; rustc 1.99.1 (Windows), 1.98 (Linux). The repo is at `Z:\dev\latent\latentPresence` since 2026-11-03; `gh` and `.cargo\bin` were added to PATH that day, so a session started before it needs them prefixed. Verified facts in `docs/SURFACE.md`.
- **Lanes:** `main` (the architect), `sub` (a subagent run in-session, for work the brief and the repo alone get right) or `human`. The Aider lane is retired (2026-09-13). `docs/WORKFLOW.md`.
- **Known, unowned:** `pins.ts` puts 6.3 kB gzip of hashes on the boot page, which downloads nothing (boot 193.0 of 195 kB; welcome 219.6 of 220, Settings 229.0 of 230: new Settings features load on use); Smart Turn scores some complete questions under 0.7 (five instances; the hangover catches them); Spike D's int8 CPU Smart Turn is not wired, so a browser without WebGPU has no spoken conversation (refused in a sentence); time-bound facts do not expire (`docs/memory.md`). rustc 1.97.1 hit internal compiler errors twice in release builds (gone on retry).
- **~500 MB of models sit in `node_modules/.pnpm/@huggingface+transformers@3.8.1/.../.cache`** from the live checks; `pnpm install --force` costs that download again.

## Tasks needing a human or a live endpoint

In `docs/TASKS.md`, each with the command that runs it. **Open for Rick:** the **laptop session** on a bigger laptop (R-13: stage frame rate on an integrated GPU, R-9: the five-minute conversation, Phase 1's exit criterion). R-1 passed on a low-end one (D-72). Done: R-2, R-4 to R-8, R-10 to R-12, R-14 to R-43, R-55 to R-72 and R-1 (D-17–D-77); R-3 withdrawn. **For the architect:** C-7 (needs Ollama running), proving an aborted answer stops the model server-side.

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
- [x] **P8 Desktop and distribution (Windows first)** — complete 2026-10-19 (D-64): T01 2026-10-17 (ADR-60, D-58), T02 (ADR-61/62), T06 (ADR-63), T03 (ADR-64), T05 (ADR-65), T04 (ADR-66).
- [x] **P9 Polish and 1.0** — complete 2026-11-05: `v1.0.0` tagged (ADR-67 to ADR-71).
- [x] **P10 Plugins** — complete 2026-11-10 (ADR-72, ADR-73; R-68, R-69, R-70: D-73, D-74, D-76).
- [~] **P11 Characters people make** — T01–T05 done, exit criterion met 2026-11-10 (ADR-74; R-72: D-77); T06 waits for tester feedback.

## Last three sessions

- 2026-11-10 claude (32) — **The driver moved under a running kernel.** R-71: WebGL failed on Debian because an `apt upgrade` replaced the NVIDIA libraries under the loaded module and brought a kernel with no headers for DKMS; `linux-headers-amd64` and a reboot fixed it, and R-71 passed (D-75): hardware WebGPU in Chrome with no sandbox flag.

- 2026-11-10 claude (33) — **Phases 10 and 11 met their exit criteria.** R-70 and R-72 passed (D-76, D-77); a friend's six notes went into the plugin guide; every living doc was read for staleness, PROJECT.md got its post-1.0 reset, and the next task is a 1.1 release.

- 2026-11-10 claude (34) — **Eight things, three plugins, 1.1.0.** The home page shows characters and plugins (four by two); Wheel of the Year joined `plugins/`; 1.1.0 prepared, waiting on pushes and the index entry.

## Dev-only routes

`/gallery` (the design system — dev-only, and absent from a production build by dead-code elimination, which the guard below does not cover), `/dev/avatar` (the renderer's debug panel; loads a local `.vrm`), `/dev/voice` (the voice pipeline with a scripted model — the only instrument for a speaker with no microphone, a timed barge-in and click analysis), `/dev/e2e` (Playwright's), `/dev/perf` (P9-T02: `/chat` with its renderer, measured by `e2e/perf.spec.ts`), `/dev/ser` (P3-T05's voice-emotion worker timing), `/dev/face` (P3-T06's face reading), `/spike/avatar` (R-1's frame-rate instrument). Spike E's `/spike/shell` was removed 2026-10-17. All but `/gallery` are dropped from production builds by the needle guard in `vite.config.ts`, which fails the build if one reaches a chunk. Their history is in `docs/HISTORY.md`.

## Quick links

Rules `CLAUDE.md` · Loop `docs/WORKFLOW.md` · Tasks `docs/LLM-PLAN.md` · Rick's checks `docs/TASKS.md` · Decisions `docs/DECISIONS.md` · Verified surfaces `docs/SURFACE.md` · Deploy `docs/deploy.md` · Research `docs/RESEARCH.md` · History `docs/HISTORY.md`
