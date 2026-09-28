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

## Namespaces

A kernel belongs to one character; every read and write carries its `characterId`.

## How it is checked

- `pnpm live:memory` — thirty exchanges over a month through the real kernel and a real model,
  scored against what she should believe at the end. glm-5.2:cloud with reasoning off: 12/12
  expected facts, 5/5 replaced ones closed, three runs of three (after the prompt was tuned once),
  7–11 extra facts, all true.
- `replay.test.ts` — the same thirty exchanges with the recorded replies and no model.

## Not yet

- **Time-bound facts do not expire by themselves**: "Priya is visiting next weekend" stays
  current after the weekend. Extraction could give such facts a `validTo`.
- **In `/chat` since P4-T04b (ADR-38):** `attachMemory` feeds the kernel from the bus and keeps a
  note ready for the prompt — facts from the kernel's cache, past turns recalled in the background
  one message behind — so no request waits on a store. Settings → Memory chooses where: this browser
  (the default), automatic (the companion when it has a database, else this browser), the companion, or off.
  The stores (P4-T04) all keep the rules in `@latentpresence/core/memory-conformance`.
