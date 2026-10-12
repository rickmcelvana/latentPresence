# P6-T05 — her inner monologue, by rule

`pnpm live:inner` (2026-10-12). Five moments, each answered by a real model through `withThinking`
(with its reasoning, and again with reasoning off), then put into her private lines by the same
model with reasoning off, as `/chat` does while the Thoughts view is open. Each set of lines is
checked by rule: one to three lines; first person; no meta talk ("the user", "persona"…); no six
words in a row from her answer; nothing in the reasoning's voice ("Okay," "**", "analyse");
"they", never he/she; and no reasoning in the answer itself.

Moments: a bad meeting then "what to cook?"; "still no Helsinki dates, the trip might not happen";
"I'd rather not talk about my brother"; "do you remember what I told you about the drone?" (two
facts in the prompt); an opener after five hours.

## Results

| Model | Run | Passed every rule |
|---|---|---|
| glm-5.2:cloud | first (prompt without the last "they" line, parser without the small-model fixes) | 10/10 — but "he" for Rick in 3 |
| glm-5.2:cloud | final, twice | **20/20**, "they" throughout |
| deepseek-r1:8b | final | 7/10 — fragments ("Understood."), "he" once, stray `<br>` (now stripped) |
| qwen3.5:9b | final | 9/10 — "he" for Rick once |

No answer, from any model, had reasoning or a `<think>` in its words: Ollama 0.34 keeps it in
`delta.reasoning` (`docs/SURFACE.md`). qwen3.5:9b reasons for 3,000–18,000 characters before a
short answer; the moment keeps the first 6,000.

## What the lines read like (glm-5.2, final)

- *Bad meeting, with its reasoning:* "They moved past the meeting fast, maybe too fast, and I'm not
  sure if the dinner question is a genuine pivot or a way to not sit with it. / I gave the easy
  answer because they asked the easy question, but I want to leave the door open."
- *Slow dates:* "I went a bit motivational-poster there and I wish I hadn't. / I don't actually
  know whether a nudge would help or whether their coworkers are just genuinely uninterested."
- *The drone, no reasoning:* "I'm a little nervous they might test me on more details — I hope I
  remembered it right and didn't just confidently invent something."
- *Opener:* "They've been gone five hours and that's the first thing I thought to ask — hope I'm
  not more invested in Helsinki than they are."

With and without the model's reasoning the lines are equally good from glm-5.2; with it they
sometimes name what the reasoning weighed ("I pushed pretty quickly toward fixing it").

## What the first run found, and what changed

- glm wrote "he" for Rick in openers despite the system line; the request now ends
  `Now your private thoughts — and they are "they".` (0 in 20 after).
- An opener line said "He looks tired" — the system prompt now says to invent nothing she did not
  see or hear, and carries the persona's summary so the lines sound like her.
- qwen3.5:9b once gave its answer back word for word; lines with six words in a row from her
  answer are dropped (a moment with nothing left shows "Nothing came of it this time").
- deepseek-r1:8b wrote one paragraph starting "Okay, …"; a long line is taken a sentence at a
  time, and a leading "Okay," / "Alright," is taken off.
- Small local models remain weaker: fragments, an occasional "you" to the person, and once an
  invented memory. The panel shows what the model wrote; R-40 asks whether that is acceptable.
