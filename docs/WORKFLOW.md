# Workflow — sessions, agents, hand-offs

Goal: any agent (Claude Code, DeepSeek, Aider) or human can pick up the project in under two minutes without reading long files.

## Roles

| Role | Who | Does | Does not |
|---|---|---|---|
| Main AI | Claude Code, sometimes DeepSeek V4 Pro | Research, plan, architecture, interfaces, tricky code, Aider briefs, auditing Aider diffs, commits, doc updates | Bulk mechanical edits when Aider can do them cheaper |
| Aider | Kimi K2.7 code via Ollama cloud, run by Rick | Executes one brief at a time, scoped to listed files | Commit, change interfaces in `packages/protocol`, touch docs other than the brief's notes |
| Rick | Human | Decides ADRs, art pipeline, accounts and keys, runs Aider, reviews demos | |

## Session ritual (every main-AI session)

Start
1. Read `PROJECT.md` (current phase, next task, blockers, last three session notes). Under 150 lines by rule.
2. Run `git log --oneline -15` and `git status`. If the log disagrees with `PROJECT.md`, trust git and fix `PROJECT.md` first.
3. Open only the task entry in `docs/LLM-PLAN.md` for the task you are taking. Skim the relevant ADR if the task touches an interface.
4. Say what you are about to do in one line.

Work
- One task at a time. Commit when its "done when" is met: `git commit -m "P1-T03: <summary>"`.
- If a decision is needed that is not in `docs/DECISIONS.md`, add a `proposed` ADR and continue with the recommended option; flag it in the session note.
- Anything learned that is not derivable from code goes into the doc it belongs to, not into chat.

End
1. Append a session note to `docs/SESSION-LOG.md` (format below, five lines max).
2. Update `PROJECT.md`: current task, next task, blockers, and the "last three sessions" list (drop the oldest).
3. Commit docs: `git commit -m "docs: session note <date>"`.

## Session note format

```
## 2026-09-07 claude — P1-T03 sentence chunker
Did: chunker + 40 tests; strips tags into events.
Left: abbreviations list incomplete (see TODO in chunker.ts).
Next: P1-T05 TTS providers (brief 0004 ready for Aider).
Decisions: none / ADR-14 proposed.
```

## Aider loop

1. Main AI writes `docs/aider/briefs/NNNN-<slug>.md` from `docs/aider/BRIEF-TEMPLATE.md`. The brief lists the exact files Aider may edit, the interface it must conform to, the tests to add, and the launch command.
2. Rick runs the launch command from the brief. Aider is always started with `--no-auto-commits --no-dirty-commits`. Repo-level defaults are in `.aider.conf.yml`.
3. Rick tells the main AI "brief NNNN done". Main AI audits: `git diff`, runs tests and lint, checks the "done when" list, fixes small issues itself, or writes a follow-up brief for larger ones.
4. Main AI commits with the task ID and marks the brief `status: merged` in its header.

Suitable for Aider: adapters that implement an existing interface, UI panels with a written design note, tests from a spec, scripts, migrations from a schema doc, refactors with a clear mechanical rule.
Not suitable: interface design, state machines, anything in `packages/protocol`, security-sensitive code, performance work needing measurement.

## Commit rules

- Main AI commits after every completed task and at session end. Conventional prefix is the task ID or `docs:`, `chore:`, `fix:`.
- Aider never commits. If Aider's diff is rejected, `git checkout -- <files>` and rewrite the brief.
- Never commit secrets, model weights, or non-redistributable assets. `.gitignore` and `.gitattributes` enforce this; the LFS list covers large approved assets.
- Branching: work on `main` while the team is one human plus agents. Feature branches when a task spans more than one session and is risky.

## Doc map

| File | Purpose | Size rule |
|---|---|---|
| `CLAUDE.md` | Rules for agents; entry point | under 80 lines |
| `PROJECT.md` | Living status: phase, current and next task, blockers, recent sessions | under 150 lines |
| `docs/SESSION-LOG.md` | Append-only session notes | prune to last 30 entries; older go to `docs/archive/` |
| `docs/DECISIONS.md` | ADR log | one entry per decision |
| `docs/PLAN.md` | Human phased plan | rarely edited |
| `docs/LLM-PLAN.md` | Task specs | append tasks, never renumber |
| `docs/RESEARCH.md` | Landscape and reasoning | updated when research changes |
| `docs/aider/` | Brief template and briefs | one file per brief |
| `docs/spikes/` | Spike write-ups | one file per spike |
