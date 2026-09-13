# Workflow — sessions, the build loop, agent hand-offs

Goal: any agent (Claude Code, DeepSeek, Aider) or human picks the project up in under two minutes without reading long files. This is the same loop as latentCreate and the other latent apps, trimmed to what this repo needs.

## Roles

| Role | Who | Does | Does not |
|---|---|---|---|
| Architect | Claude Code (Fable or Opus for big thinking), sometimes DeepSeek V4 Pro | Research, plan, interfaces, code, tests, briefs, reviews, runs the gate, **commits** | Delegate work whose correctness it has not established |
| Executor | A **subagent the architect runs in-session** (Sonnet), one brief per run, listed files only, working tree only | Commit, touch `packages/protocol`, widen its file list |
| Producer | Rick | Decides ADRs, click-throughs, art pipeline, accounts, server and Caddy | Have to be in the loop for an executor run |

## The loop (per task)

```
pick the next task in docs/LLM-PLAN.md (PROJECT.md says which)
  → architect writes or reads the brief (docs/briefs/P1-T03.md; "done when" is the contract)
  → decide the lane:
      architect-direct (default): write code + tests → pnpm gate → commit on green
      sub: brief carries the contract and the invariants → architect runs the subagent
           → architect reviews diff → pnpm gate → commit on green
  → UI tasks: Rick click-through per the brief's manual-verify list, result noted in the session log
```

- **Commit on green only.** `pnpm gate` is the pre-commit check and mirrors CI. A green gate is the go-ahead, not a checkpoint to ask at.
- **Docs-only changes skip the gate** (session notes, briefs, plan edits).
- Commit format: `P1-T03: sentence chunker` or `docs: session note 2026-09-07`, `fix:`, `chore:`.
- Keep a task's diff reviewable (roughly under 400 lines). Bigger scope splits the task (`P1-T03b`).
- Small review defects: the architect fixes them directly and says so in the commit. No delegation round trip for a one-liner.

## Delegation: why Aider was retired, and what replaced it

**The Aider lane worked exactly as designed, and that is why it is gone.** P0-T03, P1-T03
and P1-T04 went through it, and across this repo and latentCreate the pattern returned
code **byte-identical to the brief's reference four times out of four**. Byte-identical is
the whole problem: the lane's justification (ADR-13) is saving architect context, and the
brief that produces a clean run *contains the full reference implementation*. The context
was spent building it either way. What the round trip added was a dependency on Rick being
at the keyboard.

**Retired 2026-09-13, replaced by a subagent the architect runs in-session.** Same rules,
no round trip, and Rick is out of a loop they were only in for mechanical reasons. Aider
stays available for anything Rick wants to drive themselves.

**The real split is not size, it is where correctness comes from.**

- **Architect-direct (`main`)** when correctness depends on a fact that has to be measured,
  read out of a dependency's source, or decided. The fact-finding *is* the task. P1-T06 is
  the case to remember: four facts about transformers.js each changed the code, two of them
  contradicting what the code already said, and a brief containing them would have been the
  implementation.
- **Subagent (`sub`)** when a competent implementer could get it right from the brief and
  the repo alone: UI wiring across many files, bulk tests from a settled spec, migrations
  from a schema doc, retarget scripts, doc sweeps.

Rules learned in the sibling repos, kept here so they are not relearned. They applied to
Aider and they apply unchanged to a subagent:
- Briefs with **full reference code** and, per test, the **invariant it protects** come back
  near-clean. Prose specs come back not compiling.
- A brief that touches a **nullable protocol field must say how the test narrows it**. P1-T03
  was the only unclean run of the four, and this was why: a prose invariant ("capabilities
  non-null on every entry") was true of the values and false of the declared type, and six
  `TS18047` followed.
- Name every module the new code constructs, implements or calls but must not change, and
  keep it read-only. If the executor asks for a file mid-run, decline and fix the brief.
- The executor never commits and never touches `packages/protocol`.
- `.gitattributes` pins LF so an executor cannot rewrite files as CRLF and bury the diff.
- If a task class fails three fix-up rounds, stop and switch models; record it in
  `docs/DECISIONS.md`.

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
| `docs/briefs/` | One brief per task that needs one (every `sub` task, any task over ~150 lines) | |
| `docs/aider/` | Brief template and launch notes. Kept: the template is the brief format a subagent gets too, and Rick may still drive Aider directly | |
| `docs/spikes/` | Spike write-ups | one file per spike |
| `docs/pipeline/` | Character and asset pipeline instructions for Rick | |
