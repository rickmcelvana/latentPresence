# P6-T03 — a day with her page open, simulated

Written by `pnpm initiative:log` from `simulateInitiativeDay`, which drives the real
`attachInitiative` on a real conversation machine with a simulated clock (ADR-52). The person is
up from about half past seven to eleven and leaves the tab open overnight; reloads the page two
to four times a day (the budget is kept in a system block, so a reload must not refill it);
talks in bursts, typed (with time spent typing) or by voice (the panel open); and answers her
about half the time. Two follow-ups come due for the day, a third at a set hour that may be at
night. Every turn she starts is checked as it happens against the person — speaking, typing, a
call open, she busy, her last one unanswered — and the run against the budget over every
rolling 24 hours, the gap between check-ins, and no thoughts at rare or at night.

| Setting | Budget a day | Gap | Days | Turns she started (min–max a day) | Openers / follow-ups / thoughts | Rules broken |
|---|---|---|---|---|---|---|
| off | 0 | — | 30 | 0–0 | 0 / 0 / 0 | **0** |
| rare | 2 | 180 min | 30 | 2–2 | 3 / 57 / 0 | **0** |
| normal | 6 | 45 min | 30 | 5–6 | 20 / 85 / 60 | **0** |

Three-day runs (ten seeds, rare and normal) are held to the same rules in `initiative.test.ts`.

## off, seed 1 — 3 visits, 48 turns of theirs

She started nothing.

## rare, seed 1 — 3 visits, 51 turns of theirs

| Time | She | About | Answered |
|---|---|---|---|
| 08:03 | follow-up | follow:Vegetable garden:2026-10-12 | yes |
| 11:03 | follow-up | follow:Norway trip:2026-10-12 | yes |

## normal, seed 1 — 3 visits, 51 turns of theirs

| Time | She | About | Answered |
|---|---|---|---|
| 08:00 | follow-up | follow:Vegetable garden:2026-10-12 | yes |
| 08:45 | follow-up | follow:Norway trip:2026-10-12 | yes |
| 09:30 | thought | plan:plan-garden:Dig in compost | yes |
| 10:22 | thought | fact:f3 | yes |
| 23:00 | follow-up | follow:Compost delivery:2026-10-12 23:00 | no |

