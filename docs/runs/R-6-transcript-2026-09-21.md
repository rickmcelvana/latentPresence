# R-6 · Read a conversation back: `/chat` and the voice harness — run 2026-09-21

Run by Rick on the Windows box; instructions as run are `docs/TASKS.md` R-6 at 6edcf3b (now
Done, D-20). Two pastes, made with **Copy transcript** and pasted into a text editor — so the
clipboard path P1-T11 could not test in the Browser pane is exercised here. Analysed the same
day. Rick's verdict: **"the tasks went as expected"**, with one observation, below.

## By ear and eye (Rick)

- **Step 1–2, `/chat`:** as expected. The clipboard copy worked.
- **Step 3, `/dev/voice`:** as expected, except — **"when I interrupted, it started the story
  over again from the start."**
- Latency badges: **not reported**. R-6 asked whether their numbers seemed believable and the
  answer did not come back, so that half of the task is still unchecked (below).

## Reading

- **The interrupted line is the heard line, in both modes, and it is cut at the right word.**
  `/chat`: Stop landed mid-sentence and the copy ends `Before the sun rose over the Tharsis
  [interrupted]` — the streamed text, nothing the model went on to write. `/dev/voice`: the
  copy ends `... because [interrupted]`, mid-sentence, which is P1-T08's spoken-prefix
  estimate from frames rendered to the fade's midpoint, not the sentence boundary. Both are
  `transcriptToText`'s interrupted branch, and the unsaid remainder is absent from the paste
  as designed.
- **The clipboard format holds.** `You:` / `Alice:` per entry, `[interrupted]` suffix, no
  badges, no notices (nothing failed in either run).
- **No backchannel lines in the voice transcript.** The reducer drops `assistant.backchannel`,
  as P1-T11 intended, and Rick's paste has none — no "Yeah." or "Right." where R-4 heard them.
- **The story restarting is the harness's fake model, not a defect.** `/dev/voice` answers
  every turn from one fixed script (`ANSWER`, `voice-pipeline.ts`), through `FakeLLMProvider`,
  whose `stream()` ignores its request entirely (`_request`) and replays the script per call.
  P1-T08 chose it deliberately — "a barge-in test wants a long answer, the same every time,
  with no key". So a second turn *must* restart the same four sentences; a model that varied
  would make the barge-in and click checks unrepeatable. **Nothing to fix in the harness.**
- **It does point at a real gap, and the gap is not the harness's.** `/chat` keeps the
  conversation and sends it every turn, and on Stop it pushes **the heard prefix** as the
  assistant message (`ChatSession.stop`) — so a cut-off answer is remembered as what the user
  actually got, which is why Rick's `/chat` follow-up ("can you code?") behaved. **The spoken
  path has no equivalent.** `VoiceSession.respond` is a caller-supplied callback, the harness
  builds `messages: [{ role: 'user', content: text }]` per turn, and **no task in
  `docs/LLM-PLAN.md` owns conversation history for voice** — P1-T12 is persona, P1-T13
  download consent, P1-T14 the end-to-end test, and Phase 4 is long-term memory, not the turn
  loop. When P1-T13 gives `/chat` a voice, the character will answer every spoken turn with no
  idea what either of them just said. Raised as a plan gap for Rick, not taken unilaterally.
- **"One line per entry" is one *entry* per line, and a markdown answer spans several.**
  `transcriptToText` joins entries with `\n` and copies each answer's text verbatim, so the
  model's own newlines and bullets survive: the `/chat` paste's first answer is four lines,
  the coding answer eight. That is faithful to what was on screen, and it does mean the paste
  cannot be split back into entries by line. Cosmetic, nothing acted on; noted in
  `docs/ui/transcript.md` as a known property rather than changed.
- **Not covered by this run:** the latency badges (unreported), a `/chat` answer that fails
  mid-stream (the `[error]` notice line has still only been seen in tests), and Clear.

## Raw pastes (copied from the page by Rick)

### Step 1–2 · `/chat`, with Stop pressed partway

```
You: Hey, how's it going?
Alice: Hey! I'm doing well, thanks for asking. Just hanging out in the digital world, ready to help you out with whatever you need.

How are things with you? What's on your mind today?
You: Write a highly detailed, 4,000-word science fiction short story about a colony on Mars discovering an ancient, buried alien library. Divide the story into exactly 10 chapters. Each chapter must contain exactly 5 bullet points summarizing the subtext, and every single paragraph must start with a consecutive letter of the alphabet, cycling from A to Z repeatedly until the story concludes.
Alice: # THE INHERITANCE OF DUST

## A Science Fiction Short Story

---

# CHAPTER ONE: THE RED FRONTIER

Alenia Station sprawled across the rust-colored basin of Jezero Crater like a cluster of metallic mushrooms, its domed habitats connected by pressurized tunnels that hummed with recycled air and the quiet desperation of two hundred and thirty-seven human beings living on a planet that wanted them dead. Elena Vasquez had been among the first wave of colonists eleven years ago, a xenogeologist who had spent her career on Earth studying meteorite impacts through microscope lenses, only to find herself walking on the very soil she had once analyzed from a distance of fifty-five million kilometers. She loved the silence of Mars—the way the thin atmosphere carried sound only in truncated, ghostly whispers, as though the planet itself was holding its breath, waiting for something. The terraforming consortiums had promised gardens and blue skies within three generations. What they had delivered was a cluster of pressurized tin cans and a rationing schedule for water.

Before the sun rose over the Tharsis [interrupted]
You: can you code?
Alice: Yes, absolutely! I can write, debug, and explain code in a wide variety of programming languages. Whether you need help with Python, JavaScript, C++, Java, HTML/CSS, SQL, Go, Rust, or something else entirely, I've got you covered.

Here are a few ways I can help:
* **Writing code:** I can write scripts, functions, or full programs from scratch based on your requirements.
* **Debugging:** If your code isn't working, you can paste it here, and I can help you find and fix the errors.
* **Explaining code:** If you're learning to code and come across something confusing, I can break down how it works step-by-step.
* **Design & Architecture:** I can help you plan out a project, choose the right data structures, or discuss best practices.

What kind of coding project or problem are you working on?
```

### Step 3 · `/dev/voice`, simulated speaker then microphone

```
You: So yesterday I finally walked down to the old harbor, the one past the station, and the tide was so far out that you could see all the boats just sitting on the mud, and there was this man with a dog who kept trying to walk out to one of them. Anyway, after about ten minutes he gave up and went to get a coffee, and I ended up talking to him for nearly an hour about the town, and how it used to be.
Alice: The afternoon light came in low across the desk, and it caught the dust in the air. For a while nobody said anything, because [interrupted]
You: Hey, how are you?
Alice: The afternoon light came in low across the desk, and it caught the dust in the air. For a while nobody said anything, because there was nothing that needed saying. Then the kettle clicked off in the kitchen, and the moment was over. I remember thinking that I would like to keep that feeling for a little longer.
```
