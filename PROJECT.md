# PROJECT.md — latentPresence (living document)

> Load at the start of every session. Update at the end. Session-start rule: check this file against `git log` since the last session note; fix drift before new work.

## Snapshot

- **Project:** latentPresence, formerly latentAura (renamed 2026-09-07; aura.ai exists). Open-source (Apache-2.0) conversational AI with a full-body semi-realistic avatar in a video-call framing. Browser-first; optional Rust companion; MariaDB Vector memory; ships no models.
- **Domains:** `latentpresence.com` (site, docs, feedback) and `app.latentpresence.com` (the app), self-hosted behind Caddy. Rick sets up Caddy later.
- **Phase:** **0 — Foundations and spikes.** P0-T01, P0-T02, P0-T02b, P0-T03, P0-T04 landed 2026-09-08; P0-T07's harness landed the same day. ADR-16 amended and ADR-20 accepted 2026-09-08; 20 ADRs accepted.
- **Current task:** **P0-T07 Spike D** — harness built and benched, waiting on Rick's labelled run for the go/no-go.
- **Next task:** P0-T05 Spike B or P0-T06 Spike C, once P0-T07 closes.
- **Blockers:** none for code. P0-T07 cannot be closed without a microphone; Rick-side items are in the backlog below.
- **Default character:** Alice (name chosen 2026-09-07). Placeholder VRM until P7-T02.
- **Dev database:** remote MariaDB at `10.0.0.1` over the tunnel; `DATABASE_URL` in `.env`. Spike C measures RTT.
- **Toolchain:** TypeScript 7.0.2, Vite 8, Vitest 5, oxlint 1.81, React 19.2, Node 22, rustc 1.97, axum 0.8. Verified facts in `docs/SURFACE.md`.
- **Test counts (2026-09-08):** 148 TypeScript, 2 Rust. `pnpm gate` green; CI green on ubuntu and windows.
- **Voice pipeline (Spike A, 2026-09-08):** 947 ms end of speech to first audio on WebGPU/fp32; 435 ms excluding the VAD hangover, against ADR-20's 500 ms pipeline budget. WebGPU is required — wasm synthesis is 3779 ms. q8 recognition is broken on WebGPU. Details in `docs/spikes/A-voice-loop.md`.
- **Turn detection (Spike D bench, 2026-09-08):** Smart Turn v3 runs under onnxruntime-web. fp32/WebGPU is 8 ms an inference plus 38 ms for the Whisper log-mel, and agrees exactly with its own wasm run; int8/WebGPU will not load; int8 and fp32 disagree enough to cross the threshold, so the builds are not interchangeable. Cost only — accuracy on real speech is the outstanding run. `docs/spikes/D-smart-turn.md`.
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

- [ ] **Run `/spike/turn`** (P0-T07 go/no-go): `pnpm dev`, then http://localhost:5173/spike/turn. Headphones. Label each utterance before speaking it — ten "complete" (finished sentences) and ten "incomplete" (trail off mid-sentence and hold the pause). Copy the Markdown and paste it in; the false-fire rate on the incomplete ones is the number that decides this. Then repeat at threshold 0.7 and candidate 100 ms if there is time. Detail in `docs/spikes/D-smart-turn.md` under "Outstanding".

- [ ] Linux box available for Spike E (P0-T08) when it comes up.

- [ ] Character pipeline (P7): wait for `docs/pipeline/character.md`; the architect writes exact instructions first.

## Backlog (architect)

- Port model discovery (Ollama `/api/tags` capabilities, LM Studio listing, cloud presets) from latentCreate `crates/llm-bridge` to TypeScript in P1-T02.
- Scheduled tasks (ADR-14) are P6-T07 and P6-T08; tray mode is P8-T05.

## Phase checklist

- [ ] P0 Foundations and spikes — T01, T02, T02b, T03, T04 done; D built and awaiting its run; spikes B, C, E and the retrospective to go
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

- 2026-09-08 claude — P0-T07 Spike D: read the model's real input surface off both ONNX graphs (80×800, not the 128×3000 a card summary claimed) and built `/spike/turn` on Spike A's capture and VAD. Benched all four builds: fp32/WebGPU is 8 ms an inference and agrees with wasm exactly; int8/WebGPU will not load. Accuracy on speech is Rick's run.
- 2026-09-08 claude — P0-T04 Spike A: voice loop measured at 947 ms on WebGPU/fp32 (435 ms excluding the VAD hangover). Found q8 recognition broken on WebGPU, a kokoro-js `stream()` hang, and two measurement bugs of my own. ADR-20 accepted. Rick ran the machine.
- 2026-09-08 claude — P0-T03 site: reviewed the Aider run (deploy script failed on every run, three bugs in its own test, four colour literals, invisible-without-JS content), Rick deployed and verified live. ADR-16 amended to `git pull`; rsync script deleted.

## Spike harness

Two dev-only routes in `apps/web`, both dropped from production builds by the guard in `vite.config.ts` (it fails the build if either reaches a chunk). `/spike/voice` is Spike A: consent, Silero + Moonshine + Kokoro, per-turn timing. `/spike/turn` is Spike D: the same capture and VAD with a short candidate silence, plus Smart Turn v3 and a labelled confusion matrix. Delete both at P0-T09 if Phase 1 has replaced them.

## Quick links

Rules `CLAUDE.md` · Loop `docs/WORKFLOW.md` · Tasks `docs/LLM-PLAN.md` · Decisions `docs/DECISIONS.md` · Verified surfaces `docs/SURFACE.md` · Research `docs/RESEARCH.md` · Original brief `docs/brainstorm.md`
