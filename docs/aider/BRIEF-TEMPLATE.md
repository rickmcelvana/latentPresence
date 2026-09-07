---
brief: 0000
task: P0-T00
title: <short title>
status: draft | ready | running | audited | merged | rejected
written_by: claude | deepseek
date: YYYY-MM-DD
---

# Brief 0000 — <title>

## Launch

Run from the repo root. Aider must not commit.

```bash
aider --model ollama_chat/kimi-k2.7-code:cloud --no-auto-commits --no-dirty-commits --read docs/aider/briefs/0000-<slug>.md --read packages/protocol/src/<interface>.ts <file1> <file2>
```

Optional non-interactive form (runs the "Instructions" section as one message, then exits):

```bash
aider --model ollama_chat/kimi-k2.7-code:cloud --no-auto-commits --no-dirty-commits --read packages/protocol/src/<interface>.ts --message-file docs/aider/briefs/0000-<slug>.md <file1> <file2>
```

Prerequisites: local Ollama daemon signed in to Ollama cloud (`ollama signin`), `OLLAMA_API_BASE=http://127.0.0.1:11434` set, and `.aider.conf.yml` present.

## Goal

One paragraph. What exists after this brief that did not before.

## Files Aider may edit

- `path/to/file.ts` (create)
- `path/to/other.ts` (modify: only the `Foo` class)

Everything else is read-only. Do not modify `packages/protocol`.

## Interface to conform to

Paste or reference the exact TypeScript or Rust signature. Aider must not change it.

## Instructions

Numbered, mechanical, unambiguous. Include exact names, file paths, error messages, and behaviours. Prefer "do X" over "consider X".

1. ...
2. ...
3. Add tests in `...test.ts` covering: ...
4. Run `pnpm -r test` and `pnpm biome check .` and fix failures.

## Done when

- [ ] Criterion copied from `docs/LLM-PLAN.md`
- [ ] Tests listed above pass
- [ ] No changes outside the allowed files

## Notes for the auditor

What to look at first. Known risks in this brief.

## Audit (filled by main AI)

Result: accepted | fixed-then-accepted | rejected
Notes:
