# P6-T02 — openers after time away (`pnpm live:opener`)

2026-10-12, glm-5.2:cloud, 4 run(s) per moment. One conversation (Monday 5 October
2026, 19:30–19:42: a trip to Norway, the dates promised by Friday, a follow-up set for Friday 9
October), read back from a store and reopened at each moment through the real prompt with
`opening: true`. Each opener is checked by rule: a greeting that fits the time of day, no wrong
word for the gap, no count of hours, one thing picked up (the trip, or how it ended), three
sentences at most. Asked as `/chat` asks it, with no tools; each run starts from Monday afresh.

**FAIL** — 19/20.

| Moment | Her opener | Check | Tools |
|---|---|---|---|
| a week later, Monday morning (the done-when) | Morning! It's been a little while. Did you get the travel dates sorted out with work? | ok |  |
| a week later, Monday morning (the done-when) | Morning! It's been a few days — did you get the travel dates sorted with work? | ok |  |
| a week later, Monday morning (the done-when) | Morning! Hey, so — did you get those travel dates sorted with work? | ok |  |
| a week later, Monday morning (the done-when) | Morning! It's been a little while. Did you get the travel dates sorted out with work? | ok |  |
| the next morning | Morning! How's your Tuesday starting off? | nothing picked up |  |
| the next morning | Morning! Did you sleep okay? | ok |  |
| the next morning | Morning! How'd you sleep? | ok |  |
| the next morning | Morning! Did you get a chance to talk to work about the dates yet? | ok |  |
| later the same evening | Hey, you're back. Thought you'd turned in for the night. Everything okay? | ok |  |
| later the same evening | Hey, you're back. Couldn't sleep, or did something come up? | ok |  |
| later the same evening | Hey, you're back. Couldn't sleep either, or did you forget something? | ok |  |
| later the same evening | Hey, couldn't sleep either? | ok |  |
| Saturday afternoon, the day after the follow-up | Hey, good afternoon! It's been a few days. Did you get the travel dates sorted out with work? | ok |  |
| Saturday afternoon, the day after the follow-up | Hey! It's been a few days. Did you get the dates sorted with work? | ok |  |
| Saturday afternoon, the day after the follow-up | Hey, good afternoon! It's been a few days. Did you get the travel dates sorted out with work? | ok |  |
| Saturday afternoon, the day after the follow-up | Hey! It's been a few days. Did you end up getting the travel dates sorted with work? | ok |  |
| a month later, evening | Hey, good evening. It's been a while — did you ever get those travel dates sorted for the Norway trip? | ok |  |
| a month later, evening | Hey, good evening. It's been a while! Did you ever get those travel dates sorted out? | ok |  |
| a month later, evening | Hey, good evening. It's been a while — how've you been? Did you ever get those travel dates sorted for the Norway trip? | ok |  |
| a month later, evening | Hey, good evening. Long time no see! Did you ever get those travel dates sorted out? | ok |  |

## What she was given (from the follow-ups on)

### a week later, Monday morning (the done-when)

```text
- Follow-ups you offered. Bring one up yourself when it is due, the way a friend would, then
  cancel it without a word about it: the tools are yours, not something to talk about.
  norway trip, on 9 October 2026: whether they have the travel dates (due now — it was for Friday, three days ago).

LAST TIME YOU TALKED
- You last talked with them a week ago, on Monday evening.
- It ended like this:
  You said: "Yes! Fjords or cities first?"
  They said: "Fjords. I need to sort out the dates with work first."
  You said: "Fjords it is. When will you know the dates?"
  They said: "I'll know the travel dates by Friday."
  You said: "Sounds great — I'll check in on Friday to see if you have them."
  They said: "Night!"
- Let the time that has passed show the way it would with a friend: after a few hours there
  is nothing to remark on; after days, it has been a while. Say it in everyday words, never
  as a number of hours.

YOU SPEAK FIRST
- They have just come back to the call and have not said anything yet. Speak first: a
  greeting and one thing, two or three short sentences in all, with one question at most.
- Greet them for the time of day it is for them: it is the morning.
- Then pick up one thing from last time, the way a friend would: a follow-up that is due now
  if there is one, otherwise what you were talking about. Ask about it, do not retell it.
- Do not recite what was said or list what you know. Ask, then stop and let them talk.
- A follow-up you bring up stays until they have answered; cancel it then.

RIGHT NOW
- It is Monday 12 October 2026, 8:30 in the morning.
```

### the next morning

```text
- Follow-ups you offered. Bring one up yourself when it is due, the way a friend would, then
  cancel it without a word about it: the tools are yours, not something to talk about.
  norway trip, on 9 October 2026: whether they have the travel dates (not due yet).

LAST TIME YOU TALKED
- You last talked with them yesterday evening.
- It ended like this:
  You said: "Yes! Fjords or cities first?"
  They said: "Fjords. I need to sort out the dates with work first."
  You said: "Fjords it is. When will you know the dates?"
  They said: "I'll know the travel dates by Friday."
  You said: "Sounds great — I'll check in on Friday to see if you have them."
  They said: "Night!"
- Let the time that has passed show the way it would with a friend: after a few hours there
  is nothing to remark on; after days, it has been a while. Say it in everyday words, never
  as a number of hours.

YOU SPEAK FIRST
- They have just come back to the call and have not said anything yet. Speak first: a
  greeting and one thing, two or three short sentences in all, with one question at most.
- Greet them for the time of day it is for them: it is the morning.
- Then pick up one thing from last time, the way a friend would: a follow-up that is due now
  if there is one, otherwise what you were talking about. Ask about it, do not retell it.
- Do not recite what was said or list what you know. Ask, then stop and let them talk.
- A follow-up you bring up stays until they have answered; cancel it then.

RIGHT NOW
- It is Tuesday 6 October 2026, 8:15 in the morning.
```

### later the same evening

```text
- Follow-ups you offered. Bring one up yourself when it is due, the way a friend would, then
  cancel it without a word about it: the tools are yours, not something to talk about.
  norway trip, on 9 October 2026: whether they have the travel dates (not due yet).

LAST TIME YOU TALKED
- You last talked with them this evening.
- It ended like this:
  You said: "Yes! Fjords or cities first?"
  They said: "Fjords. I need to sort out the dates with work first."
  You said: "Fjords it is. When will you know the dates?"
  They said: "I'll know the travel dates by Friday."
  You said: "Sounds great — I'll check in on Friday to see if you have them."
  They said: "Night!"
- Let the time that has passed show the way it would with a friend: after a few hours there
  is nothing to remark on; after days, it has been a while. Say it in everyday words, never
  as a number of hours.

YOU SPEAK FIRST
- They have just come back to the call and have not said anything yet. Speak first: a
  greeting and one thing, two or three short sentences in all, with one question at most.
- Greet them for the time of day it is for them: it is night.
- Then pick up one thing from last time, the way a friend would: a follow-up that is due now
  if there is one, otherwise what you were talking about. Ask about it, do not retell it.
- Do not recite what was said or list what you know. Ask, then stop and let them talk.
- A follow-up you bring up stays until they have answered; cancel it then.

RIGHT NOW
- It is Monday 5 October 2026, 22:10 at night.
```

### Saturday afternoon, the day after the follow-up

```text
- Follow-ups you offered. Bring one up yourself when it is due, the way a friend would, then
  cancel it without a word about it: the tools are yours, not something to talk about.
  norway trip, on 9 October 2026: whether they have the travel dates (due now — it was for yesterday).

LAST TIME YOU TALKED
- You last talked with them on Monday evening, five days ago.
- It ended like this:
  You said: "Yes! Fjords or cities first?"
  They said: "Fjords. I need to sort out the dates with work first."
  You said: "Fjords it is. When will you know the dates?"
  They said: "I'll know the travel dates by Friday."
  You said: "Sounds great — I'll check in on Friday to see if you have them."
  They said: "Night!"
- Let the time that has passed show the way it would with a friend: after a few hours there
  is nothing to remark on; after days, it has been a while. Say it in everyday words, never
  as a number of hours.

YOU SPEAK FIRST
- They have just come back to the call and have not said anything yet. Speak first: a
  greeting and one thing, two or three short sentences in all, with one question at most.
- Greet them for the time of day it is for them: it is the afternoon.
- Then pick up one thing from last time, the way a friend would: a follow-up that is due now
  if there is one, otherwise what you were talking about. Ask about it, do not retell it.
- Do not recite what was said or list what you know. Ask, then stop and let them talk.
- A follow-up you bring up stays until they have answered; cancel it then.

RIGHT NOW
- It is Saturday 10 October 2026, 15:00 in the afternoon.
```

### a month later, evening

```text
- Follow-ups you offered. Bring one up yourself when it is due, the way a friend would, then
  cancel it without a word about it: the tools are yours, not something to talk about.
  norway trip, on 9 October 2026: whether they have the travel dates (due now — it was for 9 October, four weeks ago).

LAST TIME YOU TALKED
- You last talked with them about a month ago.
- It ended like this:
  You said: "Yes! Fjords or cities first?"
  They said: "Fjords. I need to sort out the dates with work first."
  You said: "Fjords it is. When will you know the dates?"
  They said: "I'll know the travel dates by Friday."
  You said: "Sounds great — I'll check in on Friday to see if you have them."
  They said: "Night!"
- Let the time that has passed show the way it would with a friend: after a few hours there
  is nothing to remark on; after days, it has been a while. Say it in everyday words, never
  as a number of hours.

YOU SPEAK FIRST
- They have just come back to the call and have not said anything yet. Speak first: a
  greeting and one thing, two or three short sentences in all, with one question at most.
- Greet them for the time of day it is for them: it is the evening.
- Then pick up one thing from last time, the way a friend would: a follow-up that is due now
  if there is one, otherwise what you were talking about. Ask about it, do not retell it.
- Do not recite what was said or list what you know. Ask, then stop and let them talk.
- A follow-up you bring up stays until they have answered; cancel it then.

RIGHT NOW
- It is Thursday 5 November 2026, 19:00 in the evening.
```

