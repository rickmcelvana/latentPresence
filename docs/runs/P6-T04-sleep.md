# P6-T04 — sleep over a long replay

`pnpm live:sleep` (2026-10-12). The long replay (`packages/core/src/memory/fixtures/long-replay.ts`):
Sam over twelve evenings, about twenty things in their life told once and retold in other words,
small talk between, five genuinely new things late on — 106 exchanges. Facts counted after each
evening.

## Real extraction

| Extraction | Sleep | Facts after evenings 1–12 | At the end | Duplicates |
|---|---|---|---|---|
| glm-5.2:cloud | no | 4 7 10 14 17 19 20 21 23 24 26 27 | 27 | none |
| glm-5.3-flash:cloud | no | 4 7 8 11 15 18 19 20 24 26 27 28 | 28 | none |
| glm-5.3-flash:cloud | yes (16 merge requests) | 3 6 9 15 17 21 21 24 26 27 28 31 | 31 | none; every merge answer was "nothing to merge" |

A strong model, shown the known facts, does not restate them: the count already levels off, and
the differences between runs are what each extraction chose to write (a zodiac sign, how long Sam
and Jess have been together), not duplicates. Rick's own store (weeks of use) holds 20 facts and
no duplicates by rule.

## A forgetful extractor (the case sleep is for)

`FORGETFUL=1`: every line's facts written in that line's own wording, known facts ignored — a small
local model's habit, or two tabs extracting at once. glm-5.2:cloud merges in sleep; its replies
are recorded in `long-replay.recording.ts` and replayed by `long-replay.test.ts`.

| Sleep | Facts after evenings 1–12 | At the end |
|---|---|---|
| no | 4 7 10 15 19 23 23 25 28 30 31 33 | 33 — "likes jazz", "loves Jazz", "is_into jazz", "favorite_music jazz" side by side |
| yes | 4 7 10 14 17 20 20 21 22 23 24 25 | **25** — the twenty things and the five late ones, each once |

With sleep the second half of the evenings adds facts at a fifth of the first half's rate; what it
adds is what is new. By rule alone (a model that merges nothing) the plain rewordings still go —
"likes/loves/is_into jazz" are one — and "favorite_music jazz" waits for the model.
