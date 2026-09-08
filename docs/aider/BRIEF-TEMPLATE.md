---
brief: P0-T00
title: <short title>
lane: aider | architect-direct
status: draft | ready | running | reviewed | merged | rejected
written_by: claude | deepseek
date: YYYY-MM-DD
---

# Brief P0-T00 — <title>

Briefs live in `docs/briefs/<task-id>.md`. Every Aider task gets one; architect-direct tasks over ~150 lines get one too, because the review is done against the brief.

## Lane decision

One sentence: why this is (or is not) worth an Aider run. Finished, verified code never goes through Aider (ADR-13).

## Launch (Aider lane only)

Run from the repo root. Aider must not commit.

```bash
aider --model ollama_chat/kimi-k2.7-code:cloud --no-auto-commits --no-dirty-commits --read CLAUDE.md --read docs/briefs/P0-T00.md --read packages/protocol/src/<interface>.ts --file <file1> --file <file2>
```

`--read` every module the new code constructs, implements or calls but must not change. `--file` only the files in the list below. Prerequisites: local Ollama daemon signed in to Ollama cloud (`ollama signin`), `OLLAMA_API_BASE=http://127.0.0.1:11434`, `.aider.conf.yml` present.

## Goal

One paragraph. What exists after this task that did not before. Testable.

## Files to create or modify

- `path/to/file.ts` (create)
- `path/to/other.ts` (modify: only the `Foo` class)
- `apps/web/src/theme.css` (add rules for every new className)

Everything else is read-only. Never `packages/protocol`.

## Spec

Exact behaviour: types, ranges, defaults, error cases and their user-facing wording. Reference `docs/DECISIONS.md` sections instead of restating interfaces.

## Reference implementation

Full code where the logic is tricky, formatted with the project formatter. The executor transcribes and wires; it does not design.

```ts
// integrate verbatim, adapt naming to package style
```

## Tests, each with the invariant it protects

- `test_name` — would fail if: <the thing it guards broke>.

## Done when

- [ ] Criterion copied from `docs/LLM-PLAN.md`
- [ ] Tests above pass; `pnpm gate` green
- [ ] No changes outside the listed files
- [ ] Every new className has a rule in `theme.css`

## Manual verify (UI tasks)

Numbered click-through steps for Rick with the expected result of each.

## Out of scope

Explicit non-goals.

## If unclear (Aider lane)

Do not guess. Output a numbered list of questions and stop.

## Review (filled by the architect)

Result: accepted | fixed-then-accepted | rejected
Gate: green at <commit>
Notes:
