# Workflow — sessions, the build loop, agent hand-offs

Goal: any agent (Claude Code, DeepSeek, Aider) or human picks the project up in under two minutes without reading long files. This is the same loop as latentCreate and the other latent apps, trimmed to what this repo needs.

## Roles

| Role | Who | Does | Does not |
|---|---|---|---|
| Architect | Claude Code (Fable or Opus for big thinking), sometimes DeepSeek V4 Pro | Research, plan, interfaces, code, tests, briefs, reviews, runs the gate, **commits** | Send finished work through Aider |
| Executor | Aider, `ollama_chat/kimi-k2.7-code:cloud`, run by Rick | One brief per run, listed files only, working tree only | Commit, touch `packages/protocol`, widen its file list |
| Producer | Rick | Decides ADRs, runs Aider when a brief exists, click-throughs, art pipeline, accounts, server and Caddy | |

## The loop (per task)

```
pick the next task in docs/LLM-PLAN.md (PROJECT.md says which)
  → architect writes or reads the brief (docs/briefs/P1-T03.md; "done when" is the contract)
  → decide the lane:
      architect-direct (default): write code + tests → pnpm gate → commit on green
      aider: brief carries reference code + launch command → Rick runs Aider → architect reviews diff → pnpm gate → commit on green
  → UI tasks: Rick click-through per the brief's manual-verify list, result noted in the session log
```

- **Commit on green only.** `pnpm gate` is the pre-commit check and mirrors CI. A green gate is the go-ahead, not a checkpoint to ask at.
- **Docs-only changes skip the gate** (session notes, briefs, plan edits).
- Commit format: `P1-T03: sentence chunker` or `docs: session note 2026-09-07`, `fix:`, `chore:`.
- Keep a task's diff reviewable (roughly under 400 lines). Bigger scope splits the task (`P1-T03b`).
- Small review defects: the architect fixes them directly and says so in the commit. No Aider round trip for a one-liner.

## When Aider is worth it

Aider exists to save architect context so a session runs longer. Nothing else. Ask before writing a brief:
- **Architect-direct** when the implementation is small, interface-shaped, or already written and verified. Sending it out cannot change the outcome (latentCreate saw two runs return byte-identical to the brief's reference code).
- **Aider** when the work is broad and mechanical: UI wiring across many files, transcription of a reference implementation into many call sites, bulk tests from a spec, migrations from a schema doc, retarget scripts.

Rules learned in the sibling repos, kept here so they are not relearned:
- Briefs with **full reference code** and, per test, the **invariant it protects** come back near-clean. Prose specs come back not compiling. Run reference code through the formatter before it goes in the brief.
- `--read` every module the new code constructs, implements or calls but must not change. If Aider asks for a file mid-run, decline, fix the launch command, re-run.
- Every launch carries `--no-auto-commits --no-dirty-commits` (defaults in `.aider.conf.yml` too). Aider once auto-committed a red build in a sibling repo.
- `.gitattributes` pins LF so an executor cannot rewrite files as CRLF and bury the diff.
- If a task class fails three fix-up rounds, stop and switch models; record it in `docs/DECISIONS.md`.

## Architect's review checklist

1. Diff touches only listed files; `packages/protocol` unchanged unless the task is main-owned and says so.
2. Each test would fail if the thing it guards broke. Name the invariant, not the mechanics. No vacuous round-trips.
3. No `unwrap()` or `expect()` on I/O or network paths in Rust; typed errors per crate. No `any` in TypeScript.
4. Third-party API surfaces (AI SDK, three-vrm, onnxruntime-web, MariaDB vector SQL, Tauri, Home Assistant MCP) verified against docs or a live call, never from model memory. Record verified facts in `docs/SURFACE.md` with the date.
5. Every new className has a rule in `theme.css`; `theme.test.ts` is green. No colour literals outside `:root`.
6. Secrets never reach logs, config files, sidecars or error strings; the web app stores keys encrypted, the desktop app uses the OS keychain.
7. Run the gate yourself before believing the diff.
8. React 19: no global `JSX` namespace; DOM booleans are booleans. Zustand: subscribe with selectors.
9. A doc claim that is load-bearing for the change is checked against the repo before building on it.

## Session ritual (every architect session)

Start
1. Read `PROJECT.md` (Snapshot, then the last session note). Under 150 lines by rule.
2. `git log --oneline -15` and `git status`. If the log disagrees with `PROJECT.md`, fix `PROJECT.md` first.
3. Open only the current task in `docs/LLM-PLAN.md` and its brief if one exists. Skim the ADR if the task touches an interface.
4. Say in one line what you are about to do.

Work
- One task at a time. Gate, then commit, when its "done when" is met.
- A decision not in `docs/DECISIONS.md`: add a `proposed` ADR, go with the recommended option, flag it in the session note.
- Knowledge not derivable from code goes into the doc it belongs to, not chat. Date every count.

End
1. Append a session note to `docs/SESSION-LOG.md` (five lines max, format below).
2. Update `PROJECT.md`: Snapshot, current and next task, blockers, last three sessions.
3. `git commit -m "docs: session note <date>"` (no gate needed).

## Session note format

```
## 2026-09-07 claude — P1-T03 sentence chunker
Did: chunker + 40 tests; strips tags into events. Gate green, committed 1a2b3c4.
Left: abbreviations list incomplete (TODO in PROJECT.md backlog, not in code).
Next: P1-T05 TTS providers (architect-direct).
Decisions: none / ADR-20 proposed.
Click-through: n/a | pending | passed (date)
```

## Verification against live services

Unit tests never need a running LLM, TTS server, MariaDB or ComfyUI. Providers get `Fake*` implementations and recorded fixtures; the companion gets mock transports. Live checks are producer-run at milestones from a checklist in the phase brief, results pasted into the session log. UI claims are verified with real measurements (computed style, bounding rects, store reads) or listed as unverified for Rick's click-through, never assumed.

## Doc map

| File | Purpose | Size rule |
|---|---|---|
| `CLAUDE.md` | Rules for agents; entry point | under 80 lines |
| `PROJECT.md` | Living status: Snapshot, current and next task, blockers, backlog, recent sessions | under 150 lines |
| `docs/SESSION-LOG.md` | Append-only session notes | prune past 30 entries into `docs/archive/` |
| `docs/DECISIONS.md` | ADR log | one entry per decision |
| `docs/PLAN.md` | Human phased plan | rarely edited |
| `docs/LLM-PLAN.md` | Task specs | append tasks, never renumber |
| `docs/RESEARCH.md` | Landscape and reasoning | updated when research changes |
| `docs/SURFACE.md` | Verified third-party facts with dates | append; newest dated entry wins |
| `docs/briefs/` | One brief per task that needs one (all Aider tasks, any task over ~150 lines) | |
| `docs/aider/` | Brief template and launch notes | |
| `docs/spikes/` | Spike write-ups | one file per spike |
| `docs/pipeline/` | Character and asset pipeline instructions for Rick | |
