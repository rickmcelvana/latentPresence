# latentAura — agent rules

Conversational AI with a realistic-styled full-body avatar in a video-call framing. Browser-first, bring-your-own models, **we ship no models**, MariaDB as the power store, open source. Details: `docs/RESEARCH.md`, `docs/DECISIONS.md`.

## Start every session

1. Read `PROJECT.md` (short, always current).
2. `git log --oneline -15` and `git status`. Git wins over docs when they disagree; fix the doc.
3. Read only the current task in `docs/LLM-PLAN.md`.
4. State in one line what you are about to do.

## End every session

1. Append a five-line note to `docs/SESSION-LOG.md` (format in `docs/WORKFLOW.md`).
2. Update `PROJECT.md`: current task, next task, blockers, last three sessions.
3. Commit: `docs: session note <date>`.

## Rules

- One task at a time, from `docs/LLM-PLAN.md`. Commit when its "done when" is met, message `P<phase>-T<nn>: <summary>`.
- Main AI commits. Aider never commits; its briefs always launch with `--no-auto-commits --no-dirty-commits`.
- `packages/protocol` interfaces change only in main-AI tasks with an ADR note.
- Every provider gets a `Fake*` implementation and tests.
- TypeScript for app and core (must run in the browser), Rust for `companion/`. No Python in the core.
- Never commit secrets, model weights, or non-redistributable assets. Mixamo clips stay local; the repo ships CC0 only.
- New decision needed: add a `proposed` ADR to `docs/DECISIONS.md`, go with the recommended option, flag it in the session note.
- Knowledge that is not derivable from code goes into the relevant doc, not chat.
- Doc size limits: `CLAUDE.md` under 80 lines, `PROJECT.md` under 150 lines.
- No telemetry, ever.

## Toolchain (once scaffolded, P0-T01)

```bash
pnpm install && pnpm -r build && pnpm -r test && pnpm biome check .
cargo build --manifest-path companion/Cargo.toml
```

## Pronouns and names

Rick is the project owner. Use they/them unless told otherwise.
