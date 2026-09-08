# latentPresence — agent rules

Conversational AI with a realistic-styled full-body avatar in a video-call framing. Browser-first, bring-your-own models, **we ship no models**, MariaDB as the power store, Apache-2.0. Details: `docs/RESEARCH.md`, `docs/DECISIONS.md`. Product site `latentpresence.com`, app at `app.latentpresence.com`.

**This file holds no project state.** Phase, current task and what has landed live in `PROJECT.md`.

## Start every session

1. Read `PROJECT.md` (Snapshot, then the last session note).
2. `git log --oneline -15` and `git status`. Git wins over docs when they disagree; fix the doc first.
3. Read only the current task in `docs/LLM-PLAN.md` and its brief in `docs/briefs/` if one exists.
4. State in one line what you are about to do.

## End every session

1. Append a five-line note to `docs/SESSION-LOG.md` (format in `docs/WORKFLOW.md`).
2. Update `PROJECT.md`: Snapshot, current and next task, blockers, last three sessions.
3. Commit `docs: session note <date>` (no gate for docs-only commits).

## The build loop

**Architect edits → `pnpm gate` → commit on green.** The gate mirrors CI (`tsc -b`, oxlint, vitest, vite build, cargo fmt/clippy/test). A green gate is the go-ahead to commit, not a checkpoint to ask at. Never commit red.

- One task at a time from `docs/LLM-PLAN.md`; commit message `P<phase>-T<nn>: <summary>`.
- Aider is optional and only for broad mechanical work that would burn architect context. Finished, verified code never goes through Aider. Aider launches with `--no-auto-commits --no-dirty-commits`; the architect reviews, gates, commits.
- Tests land with the code, not later. Every provider gets a `Fake*` and tests. `theme.test.ts` keeps every className styled.

## Hard rules

- Ship no models. Nothing downloads without the consent screen (size, licence, source).
- `packages/protocol` interfaces change only in architect-owned tasks with an ADR note.
- TypeScript for app and core (must run in the browser); Rust for `companion/`. No Python in the core.
- Style every component the day it is written, in `theme.css`, with the teal tokens (ADR-15). No colour literals outside `:root`.
- Never commit secrets, weights, or non-redistributable assets. `DATABASE_URL` lives in `.env`.
- No telemetry, ever. Nothing leaves the user's machine unless they pointed it somewhere.
- Third-party surfaces are verified against docs or a live call, then recorded with a date in `docs/SURFACE.md`. Never from memory.
- New decision needed: add a `proposed` ADR to `docs/DECISIONS.md`, take the recommended option, flag it in the session note.
- Doc limits: this file under 80 lines, `PROJECT.md` under 150.

## Toolchain (from P0-T01)

```bash
pnpm install && pnpm gate
```

## People

Rick is the owner and producer (they/them). Rick uses Fable or Opus for big-thinking sessions; give exact, step-by-step instructions for anything Rick must do outside the repo (art pipeline, server, Caddy).

## Sibling repos (reference only)

`../latent/latentCreate` (Apache-2.0, Rick's): model discovery code in `crates/llm-bridge`, the `theme.css` + `theme.test.ts` pattern, WORKFLOW lessons. `../latent/website/latentbeats.com`: site style and feedback form. Copy from latentCreate freely; the closed-source siblings `latent-mixing` and `latent-mastering` are not sources for this repo.
