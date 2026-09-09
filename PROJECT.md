# PROJECT.md — latentPresence (living document)

> Load at the start of every session. Update at the end. Session-start rule: check this file against `git log` since the last session note; fix drift before new work.

## Snapshot

- **Project:** latentPresence, formerly latentAura (renamed 2026-09-07; aura.ai exists). Open-source (Apache-2.0) conversational AI with a full-body semi-realistic avatar in a video-call framing. Browser-first; optional Rust companion; MariaDB Vector memory; ships no models.
- **Domains:** `latentpresence.com` (site, docs, feedback) and `app.latentpresence.com` (the app), self-hosted behind Caddy. Rick sets up Caddy later.
- **Phase:** **0 — Foundations and spikes.** P0-T01, P0-T02, P0-T02b, P0-T03 and P0-T04 landed 2026-09-08. ADR-16 amended and **ADR-20 proposed** 2026-09-08.
- **Current task:** none in progress.
- **Next task:** **P0-T07 Spike D: Smart Turn v3** — promoted ahead of B and C. Spike A found the VAD hangover is 512 ms of a 947 ms turn, so turn detection is the largest single cost in the pipeline and P0-T07 decides whether the latency target is reachable at all.
- **Blockers:** none for code. Rick-side items are in the backlog below.
- **Default character:** Alice (name chosen 2026-09-07). Placeholder VRM until P7-T02.
- **Dev database:** remote MariaDB at `10.0.0.1` over the tunnel; `DATABASE_URL` in `.env`. Spike C measures RTT.
- **Toolchain:** TypeScript 7.0.2, Vite 8, Vitest 5, oxlint 1.81, React 19.2, Node 22, rustc 1.97, axum 0.8. Verified facts in `docs/SURFACE.md`.
- **Test counts (2026-09-08):** 121 TypeScript, 2 Rust. `pnpm gate` green; CI green on ubuntu and windows.
- **Voice pipeline (Spike A, 2026-09-08):** 947 ms end of speech to first audio on WebGPU/fp32, of which 512 ms is the VAD hangover. WebGPU is required — wasm synthesis is 3779 ms. q8 recognition is broken on WebGPU. Details in `docs/spikes/A-voice-loop.md`.
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

- [ ] Linux box available for Spike E (P0-T08) when it comes up.

- [ ] Character pipeline (P7): wait for `docs/pipeline/character.md`; the architect writes exact instructions first.

## Backlog (architect)

- Port model discovery (Ollama `/api/tags` capabilities, LM Studio listing, cloud presets) from latentCreate `crates/llm-bridge` to TypeScript in P1-T02.
- Scheduled tasks (ADR-14) are P6-T07 and P6-T08; tray mode is P8-T05.

## Phase checklist

- [ ] P0 Foundations and spikes — T01, T02, T02b, T03, T04 done; spikes B, C, D, E and the retrospective to go
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

- 2026-09-08 claude — P0-T04 Spike A: voice loop measured at 947 ms on WebGPU/fp32. Found q8 recognition broken on WebGPU, a kokoro-js `stream()` hang, and two measurement bugs of my own. ADR-20 proposed. Rick ran the machine.
- 2026-09-08 claude — P0-T03 site: reviewed the Aider run (deploy script failed on every run, three bugs in its own test, four colour literals, invisible-without-JS content), Rick deployed and verified live. ADR-16 amended to `git pull`; rsync script deleted.

## Quick links

Rules `CLAUDE.md` · Loop `docs/WORKFLOW.md` · Tasks `docs/LLM-PLAN.md` · Decisions `docs/DECISIONS.md` · Verified surfaces `docs/SURFACE.md` · Research `docs/RESEARCH.md` · Original brief `docs/brainstorm.md`
