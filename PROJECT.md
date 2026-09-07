# latentAura — project status

Updated: 2026-09-07 by claude

## Where we are

- Phase: **0 — Foundations and spikes** (not started; planning complete).
- Current task: none in progress.
- Next task: **P0-T01 Monorepo scaffold** (owner: main), after Rick reviews the open questions below.
- Blockers: ADR-01..13 are `proposed`; ADR-10 (licence) needs Rick.

## Open questions for Rick

1. Licence: Apache-2.0 (recommended) or MIT? (ADR-10)
2. Avatar direction: agree with semi-realistic full-body VRM as the base, with LAM/Gaussian as later plugins? (RESEARCH §2)
3. Platform: agree with browser-first + Rust companion, Tauri for Windows/Linux, macOS gated on spikes? (RESEARCH §8)
4. Do you have a macOS or Linux machine for Spike E, or should those wait?
5. MariaDB: is 11.8 installed locally, or should Phase 0 use the docker compose file?
6. Character art: will you produce the default character in parallel with Phases 1–3, or after? (P7-T02)
7. Name of the default character and persona voice, or leave for Phase 1?
8. Ollama cloud model string: confirm `kimi-k2.7-code:cloud` is what your daemon lists (`ollama list`).

## Phase checklist

- [ ] P0 Foundations and spikes
- [ ] P1 Conversation core
- [ ] P2 Avatar and stage v1
- [ ] P3 Affect engine and emotion sensing
- [ ] P4 Memory and MariaDB
- [ ] P5 Knowledge and tools
- [ ] P6 Presence and life
- [ ] P7 Character pipeline and realism (parallel)
- [ ] P8 Desktop and distribution
- [ ] P9 Polish and 1.0

## Last three sessions

- 2026-09-07 claude — planning session 1: research + all planning docs written; no code.

## Quick links

- Rules: `CLAUDE.md` · Workflow: `docs/WORKFLOW.md` · Tasks: `docs/LLM-PLAN.md` · Decisions: `docs/DECISIONS.md` · Research: `docs/RESEARCH.md` · Original brief: `docs/brainstorm.md`
