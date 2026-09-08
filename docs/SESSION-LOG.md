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
