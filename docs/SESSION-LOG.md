# Session log

Append-only. Newest at the bottom. Five lines per entry. Prune entries older than 30 into `docs/archive/`.

## 2026-09-07 claude — planning session 1
Did: researched landscape (avatar tech, speech stack, memory, platform); wrote RESEARCH, DECISIONS (13 proposed ADRs), PLAN, LLM-PLAN, WORKFLOW, Aider template, CLAUDE.md, PROJECT.md, README.
Left: all ADRs are `proposed`; no code yet.
Next: Rick reviews RESEARCH §2 and §8 and the open questions in PROJECT.md; then P0-T01 monorepo scaffold.
Decisions: none accepted yet.

## 2026-09-07 claude — planning session 2
Did: renamed to latentPresence (ADR-19); accepted ADR-01..13 from Rick's answers, amended 07 (Windows first) and 13 (architect edits, gate, commit on green; Aider optional); added ADR-14 schedules, 15 design system (teal), 16 hosting, 17 remote dev DB, 18 Alice; added tasks P0-T02b, P6-T07/08, P8-T05; rewrote WORKFLOW from the latentCreate loop.
Left: no code. Rick's backlog in PROJECT.md (feedback API source, Caddy, tunnel check).
Next: P0-T01 monorepo scaffold, then P0-T02 and P0-T02b.
Decisions: 19 ADRs accepted.

## 2026-09-08 claude — P0-T01, P0-T02, P0-T02b
Did: monorepo scaffold with pnpm workspaces, TS7/Vite 8/React 19, cargo companion with axum /health, `pnpm gate` and CI (cce86f0, CI green on first push); protocol package — data schemas then ports, companion route table, README (995ea32, c954de9); design system, /gallery dev route, theme tests ported from latentCreate plus the no-colour-literal test (d1e27f8). 93 TS tests, 2 Rust tests, gate green.
Left: Rick's click-through of /gallery. `apps/desktop`, `site/` and `assets/` not created (their own tasks). Gallery is dev-only, so Playwright screenshots will need the dev server.
Next: P0-T03 site skeleton and deploy script (owner: aider — architect writes the brief first), or P0-T04 Spike A if Rick prefers spikes first.
Decisions: none proposed. Three judgement calls recorded in the commits — packages are `emitDeclarationOnly` because TS refuses `noEmit` on a referenced project (TS6310); pnpm 11's `minimumReleaseAge` protection kept, with oxlint pinned behind the window rather than excluded; token names follow latentCreate (`--bg`, `--text-muted`) rather than ADR-15's prose, values unchanged.
Click-through: pending — `pnpm dev`, then http://localhost:5173/gallery

## 2026-09-08 claude — P0-T03 site skeleton
Did: wrote the P0-T03 brief with the feedback API contract verified against the running service (SURFACE.md); designed a mark of its own for latentPresence, teal, six PNGs from one SVG master (2326319); reviewed Rick's Aider run and fixed five defects (9900e87, 8909dd1) — deploy.sh died on every run from a doubled backslash in an eval, its own test resolved the site root one level too high so nothing ran, four colour literals sat outside :root, and `.reveal` hid content unconditionally so the page was blank without JS. 107 TS + 2 Rust tests, gate green.
Left: `app.latentpresence.com` has no build behind it yet. The five Phase 0 spikes are untouched.
Next: P0-T04 Spike A, browser voice loop latency (architect-direct).
Decisions: ADR-16 amended — the server deploys by `git pull` then `pnpm build`, not rsync, so scripts/deploy.sh was deleted the day it was written and the DEPLOY_* variables left .env.example.
Click-through: passed 2026-09-08 (/gallery, and the live site, docs and feedback form — a submission arrived tagged `App: Latent Presence`).

## 2026-09-08 claude — P0-T04 Spike A
Did: built the voice-loop harness at /spike/voice (consent screen, three workers, per-turn timing) and measured it with Rick at the microphone. Twenty clean turns: **947 ms end of speech to first audio on WebGPU/fp32**, of which 512 ms is the VAD hangover, against 4397 ms on wasm where Kokoro takes 3779 ms. Found four real problems on the way: q8 recognition returns the same fluent nonsense for every utterance on WebGPU, kokoro-js `stream()` given a string never returns, the production build was shipping 21 MB of ONNX Runtime for an unreachable route, and my own marks were kept in one slot while turns overlap. Write-up in `docs/spikes/A-voice-loop.md`.
Left: mixed precision untested (fp32 costs 437 MB; Kokoro q8 works on WebGPU, so ~204 MB is likely). Cold-load and wasm-memory figures unmeasured.
Next: P0-T07 Spike D, promoted ahead of B and C — the hangover is 54% of the latency, so turn detection decides whether the target is reachable.
Decisions: **ADR-20 accepted** (Rick, same day) — WebGPU required for synthesis, precision chosen per stage never inherited, and the single 800 ms target replaced by two numbers because one figure hides which half the project owns. RESEARCH §3.3 and `docs/PLAN.md` now follow it, and the spike harness measures against the 500 ms pipeline budget.
Click-through: n/a — Rick ran the spike directly and supplied the numbers.
