# Memory

What the character remembers of the person, how it is written and how it is read (P4-T03,
ADR-05, ADR-17, ADR-35 to ADR-37). Code: `packages/core/src/memory`; the store behind it is any
`MemoryStore` — the companion's MariaDB (P4-T02), in memory for tests (`FakeMemoryStore`).

## Writing, after each exchange

`MemoryKernel.remember(turn)` returns at once; a queue does the work in order:

1. The turn is stored (embedded, if there is an embedder). An assistant turn's text is what the
   user heard.
2. After the character answers, the exchange is read for facts: one model call with reasoning
   off, answering `{"facts":[…],"ended":[…]}`, shown the facts already believed with their ids.
3. `planFactWrites` decides what each fact does:

| Heard | Becomes |
|---|---|
| the same subject, predicate and object again | the known fact, confidence raised (`1 − (1 − a)(1 − b)`) |
| a new value of a single-valued predicate (`lives_in`, `works_at`, `work_schedule`, …) | a new fact; the old one superseded where the new one starts |
| `replaces: <id>` | a new fact; that one superseded (works for any predicate: the allergy correction) |
| `ended: [<id>]` | that fact superseded now, nothing in its place ("the half marathon is off") |
| a replacement for a fact that had not begun yet | the old one **expired**: it was never true |
| a known fact restated as true now, believed to start later | its start moved to now; a single-valued rival ends then |

A failure is reported to `onError` and the queue carries on.

## Reading, before each turn

`recall({ sessionId, query })` embeds the query if it can and calls `retrieve` **once**. The
store leaves out the current session and anything no longer believed. The kernel re-ranks by
relevance (the store's order) 0.6, recency 0.25 (turns halve in 14 days, facts in a year) and
importance 0.15 (a fact's confidence; a turn's emotional salience from its stored `UserAffect`),
and keeps 12 facts and 4 turns. `renderMemory` turns that into prompt lines.

## Consolidation

`consolidate()` over the current facts: duplicates merge into the earliest (the copies
expired), a single-valued predicate keeps its latest value, and a fact under 0.35 confidence
recorded more than 30 days ago is expired. **Nothing is deleted**: expired and superseded facts
stay, and what she believed on any day can still be asked.

**Sleep (P6-T04, ADR-53)** runs it in `/chat`: `MemoryKernel.sleep()` first merges what was said
twice in other words — by rule (one subject, predicates of one family such as likes/loves/is_into,
the same object once case and articles are gone), then by the extraction model one subject at a
time, reasoning off, answering only with ids it was shown and never touching a follow-up — then
`consolidate()`. A merge keeps one fact, reinforced and true from the earliest start, and expires
the rest. `attachRest` (`packages/core/src/rest`) starts it after ten quiet minutes when facts are
new since the last sleep (the `_sleep` block); she rests visibly, and anything on the bus, a key
or a press wakes her and stops the sleep between steps.

## Namespaces

A kernel belongs to one character; every read and write carries its `characterId` — the
persona's `id` (ADR-55). Alice and Theo share one database (IndexedDB or MariaDB) and never see
each other's turns, facts, plans or self blocks; the conformance suite holds every store to it.

## How it is checked

- `pnpm live:memory` — thirty exchanges over a month through the real kernel and a real model,
  scored against what she should believe at the end. glm-5.2:cloud with reasoning off: 12/12
  expected facts, 5/5 replaced ones closed, three runs of three (after the prompt was tuned once),
  7–11 extra facts, all true.
- `replay.test.ts` — the same thirty exchanges with the recorded replies and no model.
- `pnpm live:sleep` and `long-replay.test.ts` — twelve evenings (106 exchanges), slept on after
  each. Real extraction made no duplicates; an extractor that ignores the known facts ends at 25
  facts with sleep against 33 without (`docs/runs/P6-T04-sleep.md`).

## Not yet

- **Time-bound facts do not expire by themselves**: "Priya is visiting next weekend" stays
  current after the weekend. Extraction could give such facts a `validTo`.
- **In `/chat` since P4-T04b (ADR-38):** `attachMemory` feeds the kernel from the bus and keeps a
  note ready for the prompt — facts from the kernel's cache, past turns recalled in the background
  one message behind — so no request waits on a store. Settings → Memory chooses where: this browser
  (the default), automatic (the companion when it has a database, else this browser), the companion, or off.
  The stores (P4-T04) all keep the rules in `@latentpresence/core/memory-conformance`.
- **The person can see and change it (P4-T05, ADR-39):** `/chat` → Memory shows what the last
  request was given, every fact (edit, delete) and every turn (search, delete). Deletes are real
  deletes, row and vector; a fact read from a deleted turn stays until deleted itself.
- **Her mood and her notes (P4-T06, ADR-40)** are self-model blocks in the same store: `_mood`
  (the system's, saved after every answer, restored aged by the time away) and up to eight notes
  she writes herself with `self_write_block`, shown in her prompt as "YOUR OWN NOTES".
