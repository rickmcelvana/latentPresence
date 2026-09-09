# PROJECT.md — latentPresence (living document)

> Load at the start of every session. Update at the end. Session-start rule: check this file against `git log` since the last session note; fix drift before new work.

## Snapshot

- **Project:** latentPresence, formerly latentAura (renamed 2026-09-07; aura.ai exists). Open-source (Apache-2.0) conversational AI with a full-body semi-realistic avatar in a video-call framing. Browser-first; optional Rust companion; MariaDB Vector memory; ships no models.
- **Domains:** `latentpresence.com` (site, docs, feedback) and `app.latentpresence.com` (the app), self-hosted behind Caddy. Rick sets up Caddy later.
- **Phase:** **0 — Foundations and spikes.** P0-T01, P0-T02, P0-T02b, P0-T03, P0-T04 and P0-T07 landed 2026-09-08. ADR-16 amended, ADR-20 accepted, **ADR-21 accepted 2026-09-09** (turn detection counts inside the pipeline budget). 21 ADRs accepted.
- **Current task:** **P0-T06 Spike C** — unblocked; the schema, the index and the top-k query are verified against a live 11.8.8, and the benchmark is what is left to build.
- **Next task:** P0-T08 Spike E (needs a Linux box with a display), then P0-T09 the retrospective.
- **Blockers:** none. No Docker anywhere, so CI uses a service container rather than a local one.
- **Default character:** Alice (name chosen 2026-09-07). Placeholder VRM until P7-T02.
- **Dev database (2026-09-09):** MariaDB **11.8.8** at `192.168.40.101` on the LAN, `DATABASE_URL` in `.env`, `ALL PRIVILEGES ON latentpresence.*`. `VECTOR(768)` with `VECTOR INDEX … DISTANCE=cosine` creates, inserts and answers top-k, and **`EXPLAIN` confirms the index is used rather than scanned**. RTT **p50 0.43 ms**. The earlier host `10.0.0.1` is 10.11.18 (no vectors) but gave the figure that matters: **p50 39.8 ms over the tunnel**, so retrieval must be one statement for any remote deployment. `docs/SURFACE.md`.
- **Toolchain:** TypeScript 7.0.2, Vite 8, Vitest 5, oxlint 1.81, React 19.2, Node 22, rustc 1.97, axum 0.8. Verified facts in `docs/SURFACE.md`.
- **Test counts (2026-09-09):** 173 TypeScript, 2 Rust. `pnpm gate` green; CI green on ubuntu and windows.
- **Voice pipeline (Spike A, 2026-09-08):** 947 ms end of speech to first audio on WebGPU/fp32; 435 ms excluding the VAD hangover, against ADR-20's 500 ms pipeline budget. WebGPU is required — wasm synthesis is 3779 ms. q8 recognition is broken on WebGPU. Details in `docs/spikes/A-voice-loop.md`.
- **Turn detection (Spike D, 2026-09-08):** **Go.** Smart Turn v3 on fp32/WebGPU with a 100 ms candidate and a 0.7 threshold answers in **168 ms** against the 512 ms hangover it replaces, and interrupted 0 of 51 held pauses across the five runs after the first. int8 will not load on WebGPU at all (loudly) and is a no-GPU fallback. First audio becomes ~593 ms sequential, ~553 ms once recognition overlaps turn detection - which ADR-21 makes P1's job, against an unchanged 500 ms budget. `docs/spikes/D-smart-turn.md`.
- **Avatar (Spike B, 2026-09-09):** **Go.** A full-body VRM 1.0 with MToon, spring bones and constraints held **570 consecutive frames with no misses at 120 Hz** (median frame 8.3 ms, worst 8.8) at 958×538 on an RTX 5060 Ti, and the lip sync reads as speech. Vsync hid the real cost, and the reading was at a quarter of the budgeted pixels — a 1080p-equivalent reading is outstanding. **wawa-lipsync emits fifteen Oculus visemes, not VRM's five**; the mapping is in `packages/avatar` with tests. `docs/spikes/B-vrm-lipsync.md`.
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

- [ ] **One more `/spike/avatar` reading, five minutes**: set **Render scale** to **2× (1080p-equivalent)**, let it settle, **Take the reading**, paste the Markdown. The first run was at 958×538 and `docs/PLAN.md` budgets 60 fps at **1080p** — four times the pixels. This is the difference between a measured pass and an extrapolated one.

- [ ] Whenever hardware allows: the same page on **a different class of GPU** — a laptop, or anything with integrated graphics. Not urgent; the current card is well above "mid-range", so the interesting number is a worse machine, not this one.

- [ ✅ ] `.env` now carries `DATABASE_URL`. Done — and it revealed the item below.

- [ ✅ ] **A MariaDB 11.7+ for Spike C.** Done 2026-09-09 — Rick pointed `.env` at `192.168.40.101`, which is **11.8.8** and does everything the task needs. The old `10.0.0.1` (10.11.18) has no vector support; its 40 ms round trip is kept in the write-up as the remote-deployment figure.

- [ ] Linux box available for Spike E (P0-T08) when it comes up.

- [ ] Character pipeline (P7): wait for `docs/pipeline/character.md`; the architect writes exact instructions first.

## Backlog (architect)

- Port model discovery (Ollama `/api/tags` capabilities, LM Studio listing, cloud presets) from latentCreate `crates/llm-bridge` to TypeScript in P1-T02.
- Scheduled tasks (ADR-14) are P6-T07 and P6-T08; tray mode is P8-T05.

## Phase checklist

- [ ] P0 Foundations and spikes — T01, T02, T02b, T03, T04, T05, T07 done (B pending one 1080p reading); C in progress; E and the retrospective to go
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

- 2026-09-09 claude — P0-T05 Spike B closed on Rick's run: **570 frames, no misses at 120 Hz**, lip sync passes. Read as frame times it is a pass with unknown headroom, and it was taken at a quarter of the budgeted pixels, so a render-scale control was added and one 1080p reading is outstanding. Spike C unblocked by `.env`.
- 2026-09-09 claude — ADR-21 accepted and followed through; then P0-T05 Spike B: verified the avatar stack against the registry and the asset files, found that wawa-lipsync speaks Oculus rather than VRM, and built `/spike/avatar`. The VRM and VRMA load. Frame rate needs a visible window, which this session did not have.
- 2026-09-08 claude — P0-T07 Spike D closed: built `/spike/turn` on Spike A's capture and VAD after reading the model's real input surface off both ONNX graphs, then Rick ran eight configurations. **168 ms against the 512 ms hangover, 0 of 51 held pauses interrupted.** Two harness defects the run exposed are fixed. ADR-21 proposed, accepted the next day.
- 2026-09-08 claude — P0-T04 Spike A: voice loop measured at 947 ms on WebGPU/fp32 (435 ms excluding the VAD hangover). Found q8 recognition broken on WebGPU, a kokoro-js `stream()` hang, and two measurement bugs of my own. ADR-20 accepted. Rick ran the machine.
- 2026-09-08 claude — P0-T03 site: reviewed the Aider run (deploy script failed on every run, three bugs in its own test, four colour literals, invisible-without-JS content), Rick deployed and verified live. ADR-16 amended to `git pull`; rsync script deleted.

## Spike harness

Three dev-only routes in `apps/web`, all dropped from production builds by the guard in `vite.config.ts` (it fails the build if any reaches a chunk). `/spike/voice` is Spike A: consent, Silero + Moonshine + Kokoro, per-turn timing. `/spike/turn` is Spike D: the same capture and VAD with a short candidate silence, plus Smart Turn v3 and a labelled confusion matrix. `/spike/avatar` is Spike B: a VRM in react-three-fiber with lip sync and a frame-rate model. Delete A and D at P0-T09 if Phase 1 has replaced them; **B's guard entries come out at P2-T01 deliberately**, because the avatar stops being dev-only there.

## Quick links

Rules `CLAUDE.md` · Loop `docs/WORKFLOW.md` · Tasks `docs/LLM-PLAN.md` · Decisions `docs/DECISIONS.md` · Verified surfaces `docs/SURFACE.md` · Research `docs/RESEARCH.md` · Original brief `docs/brainstorm.md`
