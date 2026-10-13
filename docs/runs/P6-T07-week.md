# P6-T07 — a simulated week of schedules

`pnpm schedule:log`. Thursday 29 October to Thursday 5 November 2026, America/Toronto (the clocks go
back at 02:00 on Sunday 1 November). The page is open 08:00–23:00, closed at night, away all
Saturday, then left open from Saturday 23:00 to Sunday 23:00. A person comes back when it opens
and every hour while it is open, and is told what is waiting. `src/scheduler/simulate.ts` has the
schedules; `scheduler.test.ts` holds the week to its rules.

Runs: 175 (168 ok, 1 failed, 6 skipped). Said: 7. Notified: 1. Episodes written: 169. Run twice, the log is identical.

```
Thu Oct 29 08:00 EDT  page opened
Thu Oct 29 08:00 EDT  ok         Morning summary (due Thu Oct 29 08:00 EDT) — to tell
Thu Oct 29 08:00 EDT  ok         Re-index the notes folder (due Thu Oct 29 03:00 EDT) — logged
Thu Oct 29 08:00 EDT  ok         Check the feeds (due Thu Oct 29 00:00 EDT) — logged
Thu Oct 29 08:00 EDT  ok         Check the feeds (due Thu Oct 29 01:00 EDT) — logged
Thu Oct 29 08:00 EDT  ok         Check the feeds (due Thu Oct 29 02:00 EDT) — logged
Thu Oct 29 08:00 EDT  ok         Check the feeds (due Thu Oct 29 03:00 EDT) — logged
Thu Oct 29 08:00 EDT  ok         Check the feeds (due Thu Oct 29 04:00 EDT) — logged
Thu Oct 29 08:00 EDT  ok         Check the feeds (due Thu Oct 29 05:00 EDT) — logged
Thu Oct 29 08:00 EDT  ok         Check the feeds (due Thu Oct 29 06:00 EDT) — logged
Thu Oct 29 08:00 EDT  ok         Check the feeds (due Thu Oct 29 07:00 EDT) — logged
Thu Oct 29 08:00 EDT  ok         Check the feeds (due Thu Oct 29 08:00 EDT) — logged
Thu Oct 29 08:00 EDT  skipped    Night check (due Thu Oct 29 01:30 EDT) — logged
Thu Oct 29 08:00 EDT  said       Morning summary, for Thu Oct 29 08:00 EDT: done.
Thu Oct 29 09:00 EDT  ok         Check the feeds (due Thu Oct 29 09:00 EDT) — logged
Thu Oct 29 10:00 EDT  ok         Check the feeds (due Thu Oct 29 10:00 EDT) — logged
Thu Oct 29 11:00 EDT  ok         Check the feeds (due Thu Oct 29 11:00 EDT) — logged
Thu Oct 29 12:00 EDT  ok         Check the feeds (due Thu Oct 29 12:00 EDT) — logged
Thu Oct 29 13:00 EDT  ok         Check the feeds (due Thu Oct 29 13:00 EDT) — logged
Thu Oct 29 14:00 EDT  ok         Check the feeds (due Thu Oct 29 14:00 EDT) — logged
Thu Oct 29 15:00 EDT  ok         Check the feeds (due Thu Oct 29 15:00 EDT) — logged
Thu Oct 29 16:00 EDT  ok         Check the feeds (due Thu Oct 29 16:00 EDT) — logged
Thu Oct 29 17:00 EDT  ok         Check the feeds (due Thu Oct 29 17:00 EDT) — logged
Thu Oct 29 18:00 EDT  ok         Check the feeds (due Thu Oct 29 18:00 EDT) — logged
Thu Oct 29 19:00 EDT  ok         Check the feeds (due Thu Oct 29 19:00 EDT) — logged
Thu Oct 29 20:00 EDT  ok         Check the feeds (due Thu Oct 29 20:00 EDT) — logged
Thu Oct 29 21:00 EDT  ok         Check the feeds (due Thu Oct 29 21:00 EDT) — logged
Thu Oct 29 22:00 EDT  ok         Check the feeds (due Thu Oct 29 22:00 EDT) — logged
Thu Oct 29 23:00 EDT  page closed
Fri Oct 30 08:00 EDT  page opened
Fri Oct 30 08:00 EDT  ok         Morning summary (due Fri Oct 30 08:00 EDT) — to tell
Fri Oct 30 08:00 EDT  ok         Re-index the notes folder (due Fri Oct 30 03:00 EDT) — logged
Fri Oct 30 08:00 EDT  ok         Check the feeds (due Thu Oct 29 23:00 EDT) — logged
Fri Oct 30 08:00 EDT  ok         Check the feeds (due Fri Oct 30 00:00 EDT) — logged
Fri Oct 30 08:00 EDT  ok         Check the feeds (due Fri Oct 30 01:00 EDT) — logged
Fri Oct 30 08:00 EDT  ok         Check the feeds (due Fri Oct 30 02:00 EDT) — logged
Fri Oct 30 08:00 EDT  ok         Check the feeds (due Fri Oct 30 03:00 EDT) — logged
Fri Oct 30 08:00 EDT  ok         Check the feeds (due Fri Oct 30 04:00 EDT) — logged
Fri Oct 30 08:00 EDT  ok         Check the feeds (due Fri Oct 30 05:00 EDT) — logged
Fri Oct 30 08:00 EDT  ok         Check the feeds (due Fri Oct 30 06:00 EDT) — logged
Fri Oct 30 08:00 EDT  ok         Check the feeds (due Fri Oct 30 07:00 EDT) — logged
Fri Oct 30 08:00 EDT  ok         Check the feeds (due Fri Oct 30 08:00 EDT) — logged
Fri Oct 30 08:00 EDT  skipped    Night check (due Fri Oct 30 01:30 EDT) — logged
Fri Oct 30 08:00 EDT  said       Morning summary, for Fri Oct 30 08:00 EDT: done.
Fri Oct 30 09:00 EDT  ok         Check the feeds (due Fri Oct 30 09:00 EDT) — logged
Fri Oct 30 10:00 EDT  ok         Check the feeds (due Fri Oct 30 10:00 EDT) — logged
Fri Oct 30 11:00 EDT  ok         Check the feeds (due Fri Oct 30 11:00 EDT) — logged
Fri Oct 30 12:00 EDT  ok         Check the feeds (due Fri Oct 30 12:00 EDT) — logged
Fri Oct 30 13:00 EDT  ok         Check the feeds (due Fri Oct 30 13:00 EDT) — logged
Fri Oct 30 14:00 EDT  ok         Check the feeds (due Fri Oct 30 14:00 EDT) — logged
Fri Oct 30 15:00 EDT  ok         Check the feeds (due Fri Oct 30 15:00 EDT) — logged
Fri Oct 30 16:00 EDT  ok         Check the feeds (due Fri Oct 30 16:00 EDT) — logged
Fri Oct 30 17:00 EDT  ok         Check the feeds (due Fri Oct 30 17:00 EDT) — logged
Fri Oct 30 18:00 EDT  ok         Check the feeds (due Fri Oct 30 18:00 EDT) — logged
Fri Oct 30 19:00 EDT  ok         Check the feeds (due Fri Oct 30 19:00 EDT) — logged
Fri Oct 30 20:00 EDT  ok         Check the feeds (due Fri Oct 30 20:00 EDT) — logged
Fri Oct 30 21:00 EDT  ok         Check the feeds (due Fri Oct 30 21:00 EDT) — logged
Fri Oct 30 22:00 EDT  ok         Check the feeds (due Fri Oct 30 22:00 EDT) — logged
Fri Oct 30 23:00 EDT  page closed
Sat Oct 31 23:00 EDT  page opened
Sat Oct 31 23:00 EDT  ok         Water the plants (due Sat Oct 31 10:00 EDT) — to tell
Sat Oct 31 23:00 EDT  ok         Re-index the notes folder (due Sat Oct 31 03:00 EDT) — logged
Sat Oct 31 23:00 EDT  ok         Check the feeds (due Sat Oct 31 14:00 EDT) — logged
Sat Oct 31 23:00 EDT  ok         Check the feeds (due Sat Oct 31 15:00 EDT) — logged
Sat Oct 31 23:00 EDT  ok         Check the feeds (due Sat Oct 31 16:00 EDT) — logged
Sat Oct 31 23:00 EDT  ok         Check the feeds (due Sat Oct 31 17:00 EDT) — logged
Sat Oct 31 23:00 EDT  ok         Check the feeds (due Sat Oct 31 18:00 EDT) — logged
Sat Oct 31 23:00 EDT  ok         Check the feeds (due Sat Oct 31 19:00 EDT) — logged
Sat Oct 31 23:00 EDT  ok         Check the feeds (due Sat Oct 31 20:00 EDT) — logged
Sat Oct 31 23:00 EDT  ok         Check the feeds (due Sat Oct 31 21:00 EDT) — logged
Sat Oct 31 23:00 EDT  ok         Check the feeds (due Sat Oct 31 22:00 EDT) — logged
Sat Oct 31 23:00 EDT  ok         Check the feeds (due Sat Oct 31 23:00 EDT) — logged
Sat Oct 31 23:00 EDT  skipped    Night check (due Sat Oct 31 01:30 EDT) — logged
Sat Oct 31 23:00 EDT  said       Water the plants
Sun Nov 01 00:00 EDT  ok         Check the feeds (due Sun Nov 01 00:00 EDT) — logged
Sun Nov 01 01:00 EDT  ok         Check the feeds (due Sun Nov 01 01:00 EDT) — logged
Sun Nov 01 01:30 EDT  ok         Night check (due Sun Nov 01 01:30 EDT) — logged
Sun Nov 01 01:00 EST  ok         Check the feeds (due Sun Nov 01 01:00 EST) — logged
Sun Nov 01 02:00 EST  ok         Check the feeds (due Sun Nov 01 02:00 EST) — logged
Sun Nov 01 03:00 EST  ok         Re-index the notes folder (due Sun Nov 01 03:00 EST) — logged
Sun Nov 01 03:00 EST  ok         Check the feeds (due Sun Nov 01 03:00 EST) — logged
Sun Nov 01 04:00 EST  ok         Check the feeds (due Sun Nov 01 04:00 EST) — logged
Sun Nov 01 05:00 EST  ok         Check the feeds (due Sun Nov 01 05:00 EST) — logged
Sun Nov 01 06:00 EST  ok         Check the feeds (due Sun Nov 01 06:00 EST) — logged
Sun Nov 01 07:00 EST  ok         Check the feeds (due Sun Nov 01 07:00 EST) — logged
Sun Nov 01 08:00 EST  ok         Check the feeds (due Sun Nov 01 08:00 EST) — logged
Sun Nov 01 09:00 EST  ok         Check the feeds (due Sun Nov 01 09:00 EST) — logged
Sun Nov 01 10:00 EST  ok         Check the feeds (due Sun Nov 01 10:00 EST) — logged
Sun Nov 01 11:00 EST  ok         Check the feeds (due Sun Nov 01 11:00 EST) — logged
Sun Nov 01 12:00 EST  ok         Check the feeds (due Sun Nov 01 12:00 EST) — logged
Sun Nov 01 13:00 EST  ok         Check the feeds (due Sun Nov 01 13:00 EST) — logged
Sun Nov 01 14:00 EST  ok         Check the feeds (due Sun Nov 01 14:00 EST) — logged
Sun Nov 01 15:00 EST  ok         Check the feeds (due Sun Nov 01 15:00 EST) — logged
Sun Nov 01 16:00 EST  ok         Check the feeds (due Sun Nov 01 16:00 EST) — logged
Sun Nov 01 17:00 EST  ok         Check the feeds (due Sun Nov 01 17:00 EST) — logged
Sun Nov 01 18:00 EST  ok         Check the feeds (due Sun Nov 01 18:00 EST) — logged
Sun Nov 01 19:00 EST  ok         Check the feeds (due Sun Nov 01 19:00 EST) — logged
Sun Nov 01 20:00 EST  ok         Check the feeds (due Sun Nov 01 20:00 EST) — logged
Sun Nov 01 21:00 EST  ok         Check the feeds (due Sun Nov 01 21:00 EST) — logged
Sun Nov 01 22:00 EST  ok         Check the feeds (due Sun Nov 01 22:00 EST) — logged
Sun Nov 01 23:00 EST  page closed
Mon Nov 02 08:00 EST  page opened
Mon Nov 02 08:00 EST  ok         Morning summary (due Mon Nov 02 08:00 EST) — to tell
Mon Nov 02 08:00 EST  ok         Re-index the notes folder (due Mon Nov 02 03:00 EST) — logged
Mon Nov 02 08:00 EST  ok         Check the feeds (due Sun Nov 01 23:00 EST) — logged
Mon Nov 02 08:00 EST  ok         Check the feeds (due Mon Nov 02 00:00 EST) — logged
Mon Nov 02 08:00 EST  ok         Check the feeds (due Mon Nov 02 01:00 EST) — logged
Mon Nov 02 08:00 EST  ok         Check the feeds (due Mon Nov 02 02:00 EST) — logged
Mon Nov 02 08:00 EST  ok         Check the feeds (due Mon Nov 02 03:00 EST) — logged
Mon Nov 02 08:00 EST  ok         Check the feeds (due Mon Nov 02 04:00 EST) — logged
Mon Nov 02 08:00 EST  ok         Check the feeds (due Mon Nov 02 05:00 EST) — logged
Mon Nov 02 08:00 EST  ok         Check the feeds (due Mon Nov 02 06:00 EST) — logged
Mon Nov 02 08:00 EST  ok         Check the feeds (due Mon Nov 02 07:00 EST) — logged
Mon Nov 02 08:00 EST  ok         Check the feeds (due Mon Nov 02 08:00 EST) — logged
Mon Nov 02 08:00 EST  skipped    Night check (due Mon Nov 02 01:30 EST) — logged
Mon Nov 02 08:00 EST  said       Morning summary, for Mon Nov 02 08:00 EST: done.
Mon Nov 02 09:00 EST  ok         Check the feeds (due Mon Nov 02 09:00 EST) — logged
Mon Nov 02 09:30 EST  notified   Stand-up call at 9:30
Mon Nov 02 09:30 EST  ok         Stand-up call at 9:30 (due Mon Nov 02 09:30 EST) — told
Mon Nov 02 10:00 EST  ok         Check the feeds (due Mon Nov 02 10:00 EST) — logged
Mon Nov 02 11:00 EST  ok         Check the feeds (due Mon Nov 02 11:00 EST) — logged
Mon Nov 02 12:00 EST  ok         Check the feeds (due Mon Nov 02 12:00 EST) — logged
Mon Nov 02 13:00 EST  ok         Check the feeds (due Mon Nov 02 13:00 EST) — logged
Mon Nov 02 14:00 EST  ok         Check the feeds (due Mon Nov 02 14:00 EST) — logged
Mon Nov 02 15:00 EST  ok         Check the feeds (due Mon Nov 02 15:00 EST) — logged
Mon Nov 02 16:00 EST  ok         Check the feeds (due Mon Nov 02 16:00 EST) — logged
Mon Nov 02 17:00 EST  ok         Check the feeds (due Mon Nov 02 17:00 EST) — logged
Mon Nov 02 18:00 EST  ok         Check the feeds (due Mon Nov 02 18:00 EST) — logged
Mon Nov 02 19:00 EST  ok         Check the feeds (due Mon Nov 02 19:00 EST) — logged
Mon Nov 02 20:00 EST  ok         Check the feeds (due Mon Nov 02 20:00 EST) — logged
Mon Nov 02 21:00 EST  ok         Check the feeds (due Mon Nov 02 21:00 EST) — logged
Mon Nov 02 22:00 EST  ok         Check the feeds (due Mon Nov 02 22:00 EST) — logged
Mon Nov 02 23:00 EST  page closed
Tue Nov 03 08:00 EST  page opened
Tue Nov 03 08:00 EST  failed     Morning summary (due Tue Nov 03 08:00 EST) — to tell
Tue Nov 03 08:00 EST  ok         Re-index the notes folder (due Tue Nov 03 03:00 EST) — logged
Tue Nov 03 08:00 EST  ok         Check the feeds (due Mon Nov 02 23:00 EST) — logged
Tue Nov 03 08:00 EST  ok         Check the feeds (due Tue Nov 03 00:00 EST) — logged
Tue Nov 03 08:00 EST  ok         Check the feeds (due Tue Nov 03 01:00 EST) — logged
Tue Nov 03 08:00 EST  ok         Check the feeds (due Tue Nov 03 02:00 EST) — logged
Tue Nov 03 08:00 EST  ok         Check the feeds (due Tue Nov 03 03:00 EST) — logged
Tue Nov 03 08:00 EST  ok         Check the feeds (due Tue Nov 03 04:00 EST) — logged
Tue Nov 03 08:00 EST  ok         Check the feeds (due Tue Nov 03 05:00 EST) — logged
Tue Nov 03 08:00 EST  ok         Check the feeds (due Tue Nov 03 06:00 EST) — logged
Tue Nov 03 08:00 EST  ok         Check the feeds (due Tue Nov 03 07:00 EST) — logged
Tue Nov 03 08:00 EST  ok         Check the feeds (due Tue Nov 03 08:00 EST) — logged
Tue Nov 03 08:00 EST  skipped    Night check (due Tue Nov 03 01:30 EST) — logged
Tue Nov 03 08:00 EST  said       I couldn't do "Morning summary": the calendar did not answer
Tue Nov 03 09:00 EST  ok         Check the feeds (due Tue Nov 03 09:00 EST) — logged
Tue Nov 03 10:00 EST  ok         Check the feeds (due Tue Nov 03 10:00 EST) — logged
Tue Nov 03 11:00 EST  ok         Check the feeds (due Tue Nov 03 11:00 EST) — logged
Tue Nov 03 12:00 EST  ok         Check the feeds (due Tue Nov 03 12:00 EST) — logged
Tue Nov 03 13:00 EST  ok         Check the feeds (due Tue Nov 03 13:00 EST) — logged
Tue Nov 03 14:00 EST  ok         Check the feeds (due Tue Nov 03 14:00 EST) — logged
Tue Nov 03 15:00 EST  ok         Check the feeds (due Tue Nov 03 15:00 EST) — logged
Tue Nov 03 16:00 EST  ok         Check the feeds (due Tue Nov 03 16:00 EST) — logged
Tue Nov 03 17:00 EST  ok         Check the feeds (due Tue Nov 03 17:00 EST) — logged
Tue Nov 03 18:00 EST  ok         Check the feeds (due Tue Nov 03 18:00 EST) — logged
Tue Nov 03 19:00 EST  ok         Check the feeds (due Tue Nov 03 19:00 EST) — logged
Tue Nov 03 20:00 EST  ok         Check the feeds (due Tue Nov 03 20:00 EST) — logged
Tue Nov 03 21:00 EST  ok         Check the feeds (due Tue Nov 03 21:00 EST) — logged
Tue Nov 03 22:00 EST  ok         Check the feeds (due Tue Nov 03 22:00 EST) — logged
Tue Nov 03 23:00 EST  page closed
Wed Nov 04 08:00 EST  page opened
Wed Nov 04 08:00 EST  ok         Morning summary (due Wed Nov 04 08:00 EST) — to tell
Wed Nov 04 08:00 EST  ok         Put the bins out (due Wed Nov 04 07:00 EST) — to tell
Wed Nov 04 08:00 EST  ok         Re-index the notes folder (due Wed Nov 04 03:00 EST) — logged
Wed Nov 04 08:00 EST  ok         Check the feeds (due Tue Nov 03 23:00 EST) — logged
Wed Nov 04 08:00 EST  ok         Check the feeds (due Wed Nov 04 00:00 EST) — logged
Wed Nov 04 08:00 EST  ok         Check the feeds (due Wed Nov 04 01:00 EST) — logged
Wed Nov 04 08:00 EST  ok         Check the feeds (due Wed Nov 04 02:00 EST) — logged
Wed Nov 04 08:00 EST  ok         Check the feeds (due Wed Nov 04 03:00 EST) — logged
Wed Nov 04 08:00 EST  ok         Check the feeds (due Wed Nov 04 04:00 EST) — logged
Wed Nov 04 08:00 EST  ok         Check the feeds (due Wed Nov 04 05:00 EST) — logged
Wed Nov 04 08:00 EST  ok         Check the feeds (due Wed Nov 04 06:00 EST) — logged
Wed Nov 04 08:00 EST  ok         Check the feeds (due Wed Nov 04 07:00 EST) — logged
Wed Nov 04 08:00 EST  ok         Check the feeds (due Wed Nov 04 08:00 EST) — logged
Wed Nov 04 08:00 EST  skipped    Night check (due Wed Nov 04 01:30 EST) — logged
Wed Nov 04 08:00 EST  said       Morning summary, for Wed Nov 04 08:00 EST: done.
Wed Nov 04 08:00 EST  said       Put the bins out
Wed Nov 04 09:00 EST  ok         Check the feeds (due Wed Nov 04 09:00 EST) — logged
Wed Nov 04 10:00 EST  ok         Check the feeds (due Wed Nov 04 10:00 EST) — logged
Wed Nov 04 11:00 EST  ok         Check the feeds (due Wed Nov 04 11:00 EST) — logged
Wed Nov 04 12:00 EST  ok         Check the feeds (due Wed Nov 04 12:00 EST) — logged
Wed Nov 04 13:00 EST  ok         Check the feeds (due Wed Nov 04 13:00 EST) — logged
Wed Nov 04 14:00 EST  ok         Check the feeds (due Wed Nov 04 14:00 EST) — logged
Wed Nov 04 15:00 EST  ok         Check the feeds (due Wed Nov 04 15:00 EST) — logged
Wed Nov 04 16:00 EST  ok         Check the feeds (due Wed Nov 04 16:00 EST) — logged
Wed Nov 04 17:00 EST  ok         Check the feeds (due Wed Nov 04 17:00 EST) — logged
Wed Nov 04 18:00 EST  ok         Check the feeds (due Wed Nov 04 18:00 EST) — logged
Wed Nov 04 19:00 EST  ok         Check the feeds (due Wed Nov 04 19:00 EST) — logged
Wed Nov 04 20:00 EST  ok         Check the feeds (due Wed Nov 04 20:00 EST) — logged
Wed Nov 04 21:00 EST  ok         Check the feeds (due Wed Nov 04 21:00 EST) — logged
Wed Nov 04 22:00 EST  ok         Check the feeds (due Wed Nov 04 22:00 EST) — logged
Wed Nov 04 23:00 EST  page closed
```
