# TASKS — the things that need a human or a live endpoint

Moved out of `PROJECT.md` on 2026-09-12 so each task can carry the command that does it.
`PROJECT.md` keeps a one-line pointer and the open count.

**How to use this file.** Every open task is one block: what it is, one command to run, what
a pass looks like, and what to paste back. Read the line, run it, report. Nothing here needs
you to work out *how*.

**Owners.**
- `claude` — I can run it from this repo. If it says **needs**, add that to `.env` and say go.
- `rick` — needs your hands, your hardware, or your judgement. Only these are really yours.

**Keys live in `.env`** (gitignored, never committed). `.env.example` lists every name with a
comment. A missing key makes a live check skip, never fail.

## Running the live checks

Neither is part of `pnpm gate` — they need endpoints, and a gate that depends on the
weather is not a gate. Both skip any target whose key is missing.

```bash
pnpm live:llm
```

```bash
pnpm live:tts
```

```bash
pnpm live:stt
```

`live:stt` needs no key and no server: Kokoro speaks a known sentence and both recognisers
write it down, so word error rate is computed rather than judged. It downloads ~112 MB of
recognition models the first time.

```bash
pnpm live:turn
```

`live:turn` needs no key, server or microphone either: Kokoro speaks twelve labelled
utterances and the shipped Silero and Smart Turn code endpoint them through the real
`TurnDetector`, over silence and over a noise floor. It fetches ~43 MB of turn models into
`packages/ml-web/live/out/models/` the first time, checks each against the catalog size, and
writes the full report to `live/out/turn.md`. A few minutes on CPU.

`live:bargein` needs nothing either: Kokoro speaks, each sentence is cut at a seeded frame and
faded as the worklet does, and Moonshine writes down what was left — against the spoken-prefix
estimate `assistant.interrupted` carries. Writes `live/out/bargein.md`.

```bash
pnpm live:bargein
```

```bash
pnpm live:history
```

`live:history` is P1-T12b's done-when against real models: tell the character a fact, ask
about it a turn later, then cut an answer part way and ask what was just said. It asserts
the **heard** prefix is what goes on the wire, and it is the only check that puts a
multi-turn prompt on a real one — so Anthropic's strict alternation is tested here.
`HISTORY_TARGETS` and `HISTORY_OLLAMA_MODEL` pick targets. Writes `live/out/history.md`.

```bash
pnpm live:persona
```

`live:persona` is P1-T12's done-when: 20 scripted turns with history against the default
persona, scoring spoken text, tags, on-list labels, leaked markup and language in both
directions. Keys from `.env`; a missing one skips that target. `PERSONA_TARGETS=fable,gemma4`
runs a subset, `PERSONA_OLLAMA_MODEL` picks the local model. Writes `live/out/persona.md`.
**Each run is a sample** (`temperature: null`), so a single green run is weaker evidence
than it looks — read several.

`live:tts` also writes playable WAVs to `packages/providers/live/out/` (gitignored),
re-encoded from what our own decoder produced — so if they sound right, the adapter is
right.

**The rest** — each a task's done-when or a measurement behind an ADR, hand-run, never gated.
The header comment of each script says what it needs (a key, Ollama, the companion) and which
environment variables pick targets; most write to `live/out/` or `docs/runs/`.

| Script | Task | What it checks |
|---|---|---|
| `pnpm live:kokoro` | C-5 | Kokoro `q8` against `fp32`: is the smaller download good enough |
| `pnpm live:backchannel` | P1-T09 | what Kokoro actually says for each backchannel word |
| `pnpm live:cues` | P2-T07 | a tag fires on its word, against a recogniser's word timings |
| `pnpm live:affect` | P3-T03 | the same prompt in two moods comes back in different words |
| `pnpm live:affect-voice` | P3-T03 | what a mood changes in her voice (pace, pauses), rendered |
| `pnpm live:user-affect` | P3-T04 | the model's `[user:x]` reading on 100 labelled messages |
| `pnpm live:ser` | P3-T05 | the voice-emotion models load and answer, and how fast on a CPU |
| `pnpm live:face-set` | P3-T06 | makes the labelled face set on the local ComfyUI |
| `pnpm live:memory` | P4-T03 | thirty turns through the real kernel, scored on what she believes |
| `pnpm live:chat-cut` | P4-T03 | whether glm's reasoning cut reaches `/chat` |
| `pnpm live:plan` | P4-T07 | "let's plan a vegetable garden" ends with a saved plan |
| `pnpm live:mcp` | P5-T01 | a public MCP server's tools through the gate, with a real model |
| `pnpm live:cite` | P5-T04 | five private-document questions cite the right chunk |
| `pnpm idle:log` | P6-T01 | four simulated idle hours, for variety (deterministic) |
| `pnpm live:opener` | P6-T02 | her opener at five moments: greeting, gap, one thing picked up |
| `pnpm initiative:log` | P6-T03 | a simulated day at each setting, held to the budget (deterministic) |
| `pnpm live:checkin` | P6-T03 | what she says when she speaks up, by rule |
| `pnpm live:sleep` | P6-T04 | the long replay with and without sleep; `FORGETFUL=1` records the fixture |
| `pnpm live:inner` | P6-T05 | her private lines behind five moments, by rule |
| `pnpm schedule:log` | P6-T07 | a simulated week of schedules: catch-up, delivery, a blocked notification (deterministic) |
| `pnpm schedule:fixtures` | P6-T07b | rewrites the firing fixtures the core and the companion are both held to (run after a cron change) |
| `pnpm live:schedule` | P6-T08 | four "remind me…" asks: saved at the right instant and read back (in-memory store, never the companion) |

---

## Open — rick

### Laptop session — R-13, R-1 and R-9 in one sitting · ~45 minutes
All three want a machine with **integrated graphics** (or at least not the desktop's RTX 5060 Ti).
Do them in this order: two quick frame-rate readings first, then the long conversation.

**Setup, once** (Windows; skip what the laptop already has):
1. Install **Git**, **Node.js 22 LTS** and **Chrome or Edge** (WebGPU is required — Firefox won't do).
2. In a terminal:
   ```bash
   npm install -g pnpm@12.3.4
   ```
   ```bash
   git clone https://github.com/rickmcelvana/latentPresence.git
   ```
   (or `git pull` in an existing checkout), then in the checkout:
   ```bash
   pnpm install
   ```
3. **Plug the laptop in** and set Windows power mode to **Best performance** for the readings —
   on battery an integrated GPU throttles, and the number would be the power plan's.
4. Find the GPU name: **Task Manager → Performance → GPU 0** (the name is top right).

Then **R-13**, **R-1** and **R-9** below. Nothing from the desktop carries over: the laptop's
browser asks for the character and the voice models again, and **`/settings` needs the language
model set up again** — the same way as on the desktop (for `glm-5.2:cloud`, Ollama installed and
signed in on the laptop), then **Test connection** in `/settings` before starting R-9.

### R-1 · Avatar frame rate on a different class of GPU
**Why:** every frame-rate number we have is from one RTX 5060 Ti. The interesting machine is
a worse one — a laptop, or anything with integrated graphics. Not urgent; nothing is blocked.

```bash
pnpm dev
```
Then open `http://localhost:5173/spike/avatar` on the laptop, agree to the download, and let it run
~30 s with the tab visible. (This is Spike B's bare avatar, so it pairs with R-13's stage reading:
the difference between the two is what the room costs on that GPU.)

**Expect:** the page prints a frame-rate table (median, 5th percentile, worst frame).
**Report:** paste the table plus the GPU name. `docs/spikes/B-vrm-lipsync.md` gets the row.

### R-9 · The five-minute conversation · **ready to run** (P1-T15 landed 2026-09-22)
**Why:** this is Phase 1's exit criterion, not a nice-to-have — *"five-minute unscripted
voice conversation with interruptions, under 1 s to first audio on a mid-range laptop with
browser models, and under 600 ms with a local server"* (`docs/PLAN.md`). Every piece is
built and measured; nobody has held a long conversation with her, and the timing half looks
unlikely to pass as written (R-8 measured 1.8–9.2 s end to end with real models).

**Run:**
```bash
pnpm build
```
```bash
pnpm --filter @latentpresence/web run preview -- --port 4173
```
Open `http://localhost:4173/chat` (or use `pnpm dev` and port 5173 if the build gives trouble), press **Start voice**, agree to the download on the first call, and talk to her
for five minutes, interrupting often. **A production build is the point** — that is the half
nobody has checked, and `/chat` is the same page in both. Two things to expect: the first
call fetches **21.6 MB of onnxruntime wasm** from our server *before* Silero's 2.2 MB starts,
and the 473 MB of browser weights download with **no progress and no cancel** while the panel
says "Loading…".
**Report:** the transcript, the latency badges, and what it felt like after minute three.
`docs/runs/R-9-conversation-<date>.md`.

### R-13 · Stage frame rate on an integrated GPU · **desktop half passed 2026-09-23; laptop half open**
**Why:** P2-T05's done-when is *"60 fps at 1080p on Rick's machine and 30 fps on an integrated
GPU"*. The Browser pane cannot measure it — a hidden pane runs no frames. Two halves: **this
desktop now**, and **the laptop when it is ready** (do it alongside R-1 and R-9).

**Run:**
```bash
pnpm dev
```
1. Open `http://localhost:5173/dev/avatar`, **Agree and download**.
2. In **Stage**: **Camera** `full` (the most on screen), **Shadows** `on`, **Render scale** `1080p`.
3. Keep the tab visible and still for ~20 s (moving the mouse over it is fine), then **Take reading**.
4. Repeat with **Shadows** `off` — if the laptop misses 30 fps with shadows, this is the first dial.

**Report:** the reading line for each (median fps, 5th percentile, worst frame, canvas size) and
the GPU name. Pass is a median of 30+ on the laptop.

**Desktop, 2026-09-23 (Rick), RTX 5060 Ti, `full`, 1080p (1920×1078):** first read at a 60 Hz
refresh left over from a clean driver install (59.9 fps, capped), then re-read at 120 Hz —
**shadows on and off identical: 120.5 fps median · 119.0 fps 5th percentile · worst frame
8.5 ms.** The same median Spike B read with no room at all: the stage and its shadows cost
nothing measurable here, and the page still runs at the display's refresh. **The 60 fps half
passes with 2× margin.**

### R-58 · Home, notes and documents from the app · ~10 minutes
**Why:** P8-T06's done-when — a person connects Home Assistant and a notes folder from the app,
with no file edited.
1. Install the new installer here (over the old one is fine).
2. **On this PC (your files exist):** Settings → On this computer. Each of Home Assistant, Web
   search and the "mine" database shows "In mcp.json, in plain text". Press Save on each: they
   should change to "Saved in Credential Manager", and `%APPDATA%\latentPresence\mcp.json` should
   no longer hold the token, the key or the password (open it with the Open mcp.json button —
   Playwright and "everything" are still there). Home Assistant should say Connected. Then ask
   her to turn on a light, read a note, and look something up in a manual. Also run
   `pnpm companion` from the checkout once: it should still reach Home Assistant (it reads the
   token from Credential Manager now).
3. **On your wife's PC (no files):** setup's step 5 "Your home, notes and documents": your Home
   Assistant address and a token, a notes folder with Add a folder…, then ask her something about
   a note.
4. Tools → Add a server with the Home Assistant address: Test should now say it is running but
   refuses the app, and point to Settings → Home Assistant.

**Pass:** all of it with no file opened by hand. **Paste back:** anything confusing, and anything
that said an error.

## Open — claude (say go, or add the key)

P1-T08 answered two of the three browser questions in the Claude desktop app's Browser pane
(D-15, D-16). The third — how often a person triggers ADR-25's retraction — needs a person, and
was part of R-2: **no retraction in four microphone turns** (D-17), too few to call a rate.

### C-7 · An aborted answer stops the model, not just the stream · **needs** a local Ollama running
**Why:** barge-in aborts `LLMProvider.stream()`. P1-T08 proved the signal reaches the fake;
not that the OpenAI-compatible adapter cancels the HTTP request, so a local model could keep
generating on the GPU that synthesis and Smart Turn need. **No script yet** — say go with
Ollama up and I will write it: start a long answer, abort after the first tokens, and read
Ollama's own log for the request ending rather than trusting the client going quiet.

## Done

Newest first. Each line is the outcome, not the instructions — the detail is in
`docs/SESSION-LOG.md` and the facts are in `docs/SURFACE.md`.

- **D-59 · R-57: someone new through the first-run wizard** — Rick's wife, 2026-10-17: **passed** —
  she installed and ran setup herself, with Rick's local OpenAI-compatible server; microphone,
  camera and voice all worked. **The only pause: the MariaDB step** (an environment variable) — she
  would have skipped it and asked Rick for database access later. So the address is now typed into
  the app itself (ADR-62). "Skip setup" worked and led to Setup or Settings. Also from Rick: Settings
  had no way out but the browser's Back — it has a page bar now (1950989).
- **D-58 · R-56: the desktop app from its installer** — Rick 2026-10-17: **passed**, on this PC
  and another, each uninstalled first and installed fresh from the new installer. Talking within a
  few minutes; every API key worked (DeepSeek, Qwen, Ollama Cloud included); the Windows toast came
  with the app minimised; the second launch came to the front; nothing left running after closing.
  The first run (same day) found four bugs, fixed in 6d9f749 and 36ec482: a key typed but not saved
  was not used; the model listing sent no key (DeepSeek/Qwen 401); Ollama Cloud needs the relay;
  and no toast — an installer older than 73a3be2, and WebView2 never reporting the page hidden.
- **D-57 · R-55: her body, swapped while you talk** — Rick 2026-10-16: **passed** — changing the
  VRM mid-conversation "works great", and importing a `.vrm` works "wonderfully". The generated
  Alice sometimes did not load; rather than chase it she is **taken out** (not good enough to ship;
  ADR-59 amended). **R-3 withdrawn** the same day: image-to-vrm continues outside this repo.
- **D-56 · R-43: reminders said and notified** — Rick 2026-10-14: **passed** — a tea reminder set
  by voice in a call was said the moment `/chat` reopened after the tab was closed; Thursday at 9
  showed right and moved to Finished when cancelled. The hidden-tab notification first seemed
  missing: **Windows' Do Not Disturb was on** and the toast sat in the notification centre. With it
  off, the banner shows and a click brings Rick back to her tab; she does not say it again. Fixed on
  the way (4eb99c2): shown is now the `show` event, not the constructor; `glm-5.3-flash:cloud`'s
  `[sim user - neutral]` is lifted out as `[user:neutral]`.
- **D-55 · R-42: restart the companion on the new build** — Rick 2026-10-13: **passed** — the
  companion restarted on the P6-T07b build (migration 0005) before P6-T08's gate ran, and `/chat`
  remembers as before.
- **D-54 · R-41: meet Theo** — Rick 2026-10-13: **passed** — Theo sounds and talks differently, "a
  totally different vibe than Alice", calm and matter of fact; neither knew what Rick told the
  other; switching is quick. Research and tools with him worked; memories stayed apart. No change
  to his persona: both "very easy to listen to for giving instructions or reading back research".
- **D-53 · R-37: come back to her** — Rick 2026-10-13: **passed** — she opened several times over
  24 hours; the greetings made sense and felt like normal conversation. **Not yet tried: a long gap
  (days)** — Rick is in and out constantly; the simulated week (`time.test.ts`) covers the wording.
- **D-52 · R-27: plan something with her** — Rick 2026-10-13: **passed** (retry) — she brought up
  the planned trip herself, added to the plan when he gave her new information, the Markdown reads
  cleanly, and she raised it "like a conversation with a normal person".
- **D-51 · R-40: peek at her thoughts** — Rick 2026-10-12: **passed** — the lines sound like her
  ("quirky attitude of sorts"), one "eerily intuitive"; worth having there. Two quoted: after he
  said "as usual", *"They said 'as usual' like it's a small joke between us, and I liked that more
  than I probably should"*; after a 👍 on his way out for fajitas, *"I got a 👍 instead of a
  sentence — small thing but I noticed the shift to shorthand"* and *"Chill server day is my
  guess, not something they said"*. "They" throughout. ADR-54 accepted.
- **D-50 · R-32: ask her about a database of yours** — Rick 2026-10-12: **passed** — a Postgres
  user and server added to `mcp.json` (Postgres reached through his tunnel); she read the database
  without trouble; asked to delete, she said she only had read-only access and did not try. The
  cards showed her SQL as expected.
- **D-49 · R-39: let her rest** — Rick 2026-10-12: **passed** — head down, "Alice is resting,
  sorting through what you have talked about" at the top; a mouse click woke her fast; it felt
  good, and nothing in Memory was there twice. ADR-53 accepted.
- **D-48 · R-38: let her speak up** — Rick 2026-10-12: **passed** — asked to check back in an
  hour after a meeting, she did ("meeting done? Did you get those Helsinki dates from your
  co-workers?"); unprompted, twice: the Traficom drone map before flying near the waterfront (the
  plan's drone step), and, after new dates, that a two-week stay from 26 October would meet Kekri
  in early November (from his earlier question about pagan-themed holidays). Real, short, on time.
- **D-47 · R-36: watch her when nobody is talking** — Rick 2026-10-12: **passed** on the retry —
  every move looked right in `/dev/avatar`; in `/chat`, after a typed answer about Scandinavian
  holidays, she idled on her own (a stretch seen). She also raised R-27's trip plan unprompted.
- **D-46 · R-35: look at the whiteboard and the screen** — Rick 2026-10-12: **passed** — both
  look great and are readable; not crowded; it still looks like a room.
- **D-45 · R-34: ask her to turn on a light** — Rick 2026-10-11: **passed** — his own Home
  Assistant on a Raspberry Pi (Home Assistant OS 18.3, Core 2026.10.1), a few devices moved onto
  its network so far; more to follow as he moves them.
- **D-44 · R-33: ask her the weather** — Rick 2026-10-11: **passed** — with Tavily she searched,
  read weatherapi.com and weather.gc.ca for Halifax, and answered with no errors. Rick's SearXNG
  `settings.yml` is updated (json format, limiter), and Playwright MCP is in his `mcpServers`.
- **D-43 · R-31: ask her about your documents** — Rick 2026-10-11: **passed** — every answer
  matched his manuals, and she cited the source and page.
- **D-42 · R-30: index your own documents** — Rick 2026-10-11: **passed** (second try, after
  49a627c) — `C:/Users/rickm/Documents/manuals`: 3 documents, 309 chunks, nomic-embed-text
  (768); the rescan saw 3 and indexed 0; no failures.
- **D-41 · R-29: tools from the companion** — Rick 2026-10-11: **passed** (third try) — Files
  reads a long note and finds the line; a file outside the folder is refused and she says so,
  with glm-5.2, Gemma 4 31b and deepseek-v4.1-flash. The first try found the 8,000-character
  cut (586cf4e); the second, Gemma writing its tool calls as text (d114a19).
- **D-40 · R-28: let her use a tool** — Rick 2026-10-09: **passed** — tool calls work, Deny,
  Always allow and Stop all behave. One try without the companion running did not call a tool;
  not reproduced (MCP tools work with the companion down in the pane, 2026-10-09) — likely the
  same unreachable-companion memory that broke R-27's first try, now announced in the transcript.
- **D-39 · R-26: does she remember you?** — Rick 2026-09-30: **passed** — she uses what she
  was told naturally in ordinary conversation, gets changes right, and it reads as remembered
  rather than recited. P4-T04b's done-when is met by a person.
- **D-38 · R-25: does she listen like she means it?** — Rick 2026-09-27: **passed** — **no
  reaction contradicted Rick's tone**; the amount "seems right". P3-T08's done-when is met with
  the parameters unchanged.
- **D-37 · R-24: does she read you, in a real call?** — Rick 2026-09-27: **passed** — after
  the restart with `--force` (417de44). **`fused` followed Rick's expressions; talking alone
  kept the face row neutral** (the speaking half-weight does its job); **she kept up while
  Rick talked and answered**. No recording pasted. P3-T07's voice and face channels are now
  checked on a person.
- **D-36 · R-23: making faces at `/dev/face`** — Rick 2026-09-27: **passed** — "pretty on
  point", except that **what Rick means as sad reads as angry most times**. The generated set
  showed the same pull (one sad face read angry on lowered brows): MediaPipe reports the
  brow-lowering of a sad face and barely the frown, and anger is scored on the brows. For
  P3-T08 and the fusion: a face "angry" is weak evidence of anger; the text and the model's
  read decide between the two.

- **D-35 · ADR-34 accepted** — Rick 2026-09-25: MediaPipe stays pinned to tasks-vision
  0.10.35, below the telemetry 1.x added, with the worker's request guard and the bundle test.
  R-23 (making faces at `/dev/face`) stays open and optional.

- **D-34 · R-22: does it hear you?** — Rick 2026-09-25, speaking in five tones on `/dev/ser`:
  **one take read "happy" at a high percentage; most of the others looked like** *"neutral
  (confidence 0.43, 23 ms) — neutral 0.43, happy 0.26, surprised 0.12"*. The 23 ms says the
  default distill; whether base was tried was not reported. So the voice channel mostly
  hears "neutral, a bit happy" — as its own card warned. **For P3-T07: weight the voice
  reading low, and treat a sub-0.5 neutral from it as no evidence**, not as "calm".

- **D-33 · R-21: ADR-32 and P3-T04's thresholds** — Rick 2026-09-24: **both accepted** as
  proposed. The Anthropic account's credit (Fable live checks) is still his to top up.

- **D-32 · R-20: her mood in a live call** — Rick 2026-09-24: **passed on all three** — at the
  start she was the same as before; after a sad run her resting face and gaze read as low
  ("looks good") and her replies slowed; over ten minutes she came back towards herself and the
  pace "seemed right". P3-T09 closed; the engine's hand-set gains and half-lives stand.

- **D-31 · R-19: her mood in her voice** — Rick 2026-09-24: all the renders on one shuffled
  playlist — **"I could tell the low from the others"**, by its slower pace; beyond speed the
  moods sound the same, as expected with Kokoro having no emotion control. Bright was not
  reported as distinct from rest (+11% vs −12%). Done-when met (two moods audibly different,
  low vs the rest); P3-T03 closed. Bright's pace is a candidate to push towards Kokoro's 1.25
  if P3-T09's live call wants it.

- **D-30 · R-18: her moods, ten states** — Rick 2026-09-24: **all ten pass**, gone through a
  couple of times on `/dev/avatar`. P3-T02's region tables stand unchanged. P3-T02 closed.

- **D-29 · R-17: hear her answer a typed message** — Rick 2026-09-23: **passed** — "everything
  looks good"; the Stop cut-off and fade were good, the unsaid rest struck through in the
  transcript, and no crash stopping voice or anywhere else. P2-T08 closed.

- **D-28 · R-16: emotes and gestures** — Rick 2026-09-23: **passed on all** — "the gestures and
  emotes are good", the voice chat good, "not too fidgety". P2-T07's mappings and amplitudes
  stand unchanged. (Mid-sentence tag timing on Kokoro is P2-T09's, not a look problem.)

- **D-27 · R-12: pick her animation clips** — Rick 2026-09-23: Quaternius UAL Standard downloaded to
  `assets/clips/source/`; **`Idle_Loop`** for idle, nothing in the free pack for the gestures;
  **standing**; Blender 5.2 + VRM add-on + Blender's MCP installed. From the file: `Idle_Talking_Loop`
  for talk. The retarget turned out to need no Blender (ADR-31).

- **D-26 · R-15: does her body look right?** — Rick 2026-09-23: no clipping, twists or foot
  sliding; voice chat's idle → talk → idle "looks smooth". **The idle's fists** ("like she's
  ready to fight") were relaxed the same day (`relaxFingers` 0.6, 736c97e). **Typed replies
  never animate** — correct as built (no audio, so never `speaking`); **Rick decided: typed
  replies are spoken aloud**, a switch once voice is set up — P2-T08.

- **D-25 · R-14: the call layout on real hardware** — Rick 2026-09-23: camera PiP, mute,
  resize and lip sync in live calls ("her mouth moved with her voice", several calls) pass.
  Two overlaps it found — the voice card behind the text box, the text box under the drawer —
  fixed in 1cf832e and 05c7c4b.

- **D-24 · R-11: watch her talk** — run by Rick 2026-09-22, two recordings: **"The mouth and
  lip syncs looked good to me."** Measured from the videos: the mouth is ~50–60 ms behind the
  sound on both Kokoro recordings (analysis 40–50 ms, display ~10 ms) — under the 80 ms bar.
  A first reading ("within one frame", and +110 ms on Rick's file) was withdrawn the same day. `docs/runs/R-11-lipsync-2026-09-22.md`.

- **D-23 · R-10: does she look alive?** — reviewed by Rick 2026-09-22 on `/dev/avatar`'s Life
  panel: **"No frozen time. Not too much blinking. Looks good."** P2-T02's done-when met with
  `DEFAULT_LIFE_PARAMS` unchanged.

- **D-22 · R-8: hear the character remember you** — run by Rick 2026-09-22 on the Windows
  box against `glm-5.2:cloud` and then a local `gemma4:12b-it-qat`, analysed the same day; `docs/runs/R-8-history-2026-09-22.md`.
  **"Works as intended."** The first run of the whole spoken pipeline against a **real**
  model rather than the scripted answer. Recall held across turns ("Jamie. You said your
  wife's name is Jamie."), and a barge-in cut at `…Pakistan, Nigeria,` was repeated back as
  **"India, China, the US, Indonesia, Pakistan, and Nigeria. That's the top six."** — it
  counted the six it had said and knew nothing of the seventh it was generating.
  **ADR-25's retraction fired in the wild** (0.96, resumed after 320 ms) and left nothing in
  the next request. **Meets P1-T12b's done-when.** **Rick then ran a second leg on a local
  `gemma4:12b-it-qat` unasked, and it settled the latency question:** end-to-end is
  **1.8–6.1 s cloud and 4.8–9.2 s local** (plus a 17.8 s cold load), while our own share
  is unchanged — turn ends 218–279 ms after speech, synthesis 299–818 ms. That
  **confirms** ADR-20, whose budget excludes the model call and predicted exactly this, and
  corrects the intuition that local means fast. ADR-20 amended.
- **D-21 · R-7: who owns conversation history for the spoken path** — decided by Rick
  2026-09-21, same day it was raised. **Its own P1 task, before P1-T13**: `P1-T12b`, one
  `ConversationHistory` in core that `ChatSession` and `VoiceSession` both write to, carrying
  barge-in's heard-not-meant rule. So voice never ships without memory between turns, and P4
  inherits the rule instead of rediscovering it.
- **D-20 · R-6: read a conversation back in `/chat` and the voice harness** — run by Rick
  2026-09-21 on the Windows box, analysed the same day; `docs/runs/R-6-transcript-2026-09-21.md`.
  **"The tasks went as expected."** The clipboard copy worked (the one thing the Browser pane
  could not test), the format held, an interrupted line carried the heard words and cut at the
  right word in both modes — `/chat` mid-sentence at Stop, `/dev/voice` mid-sentence at the
  fade's midpoint — and there were **no backchannel lines** in the voice transcript. Rick's one
  observation, the story restarting after an interruption, is `FakeLLMProvider` replaying the
  harness's single script, which P1-T08 chose on purpose; **nothing to fix**. **Gap found, not
  in the harness:** `/chat` remembers a cut-off answer as the heard prefix, and the spoken path
  keeps no history at all — no plan task owns it (see R-7). **Latency badges went unreported**,
  so P1-T11's done-when is met on format and content but not on the badges.
- **D-19 · R-5: configure Ollama and NVIDIA from the settings page, without docs** — run by
  Rick 2026-09-14. Ollama: models listed, replies from `nemotron-3-nano:30b-cloud` (0.4 s) and
  `qwen3.5:9b` (5.3 s). NVIDIA: key saved, 81 models through the companion, a reply from
  `meta/llama-3.2-11b-vision-instruct` in 0.2 s; step 4 (reload) not reported. **Gap found:** no mention of `pnpm companion`
  until a test failed — fixed in 4777a54. **Meets P1-T10's done-when; ADR-29 accepted on it.**
- **D-18 · R-4: hear the backchannels, and talk into them** — run by Rick 2026-09-13 on the
  Windows box, analysed the same day; `docs/runs/R-4-backchannels-2026-09-13.md`. The words
  sound right and **duck beat cut** by ear; the rules held with a person's pauses (4 clips in
  ~65 s, 14–22 s apart) and **every clip started inside a turn was talked into** (10 of 10
  with P1-T09's runs). The cut session played one clip, cut at 73 ms; its "talking longer"
  was the character's answers. A clip before the answer (3 of 7) sounded fine. Found and
  fixed a harness bug: the latency column timed superseded answers from a backchannel.
  **ADR-28 accepted on it.**
- **D-17 · R-2: listen to the character, and talk over it** — run by Rick 2026-09-13 on the
  Windows box, analysed the same day; `docs/runs/R-2-voice-2026-09-13.md`. **No clicks** by
  ear or by the output check (0 of 58 events); the barge-in cut is "very fast" and the
  *Heard* column ended on the word Rick last heard; gaps and dips sound good. **Echo never
  reached the gate** — a 16 s answer through speakers with the microphone live, not one duck —
  and a cough did nothing either. The microphone path worked first time (model turn ends
  228–253 ms after speech). **ADR-26 and ADR-27 accepted on it.** Closes P1-T05's and
  P1-T08's manual done-whens.
- **D-16 · Turn detection latency on WebGPU, this onnxruntime version** — done 2026-09-13 by
  P1-T08 in the Browser pane. Smart Turn fp32 answers in **8–57 ms** warm; the **first
  inference of a session took 392–479 ms** and landed as `late`, so the worker now warms up
  during load (first real answer after that: 28 ms). Turn ends 187–279 ms after speech.
- **D-15 · Kokoro `q8` on WebGPU** — done 2026-09-13 by P1-T08. **Broken, silently**: speech-
  shaped audio Moonshine could not read a word of, while fp32 through the same worker matched
  node to the frame. Every quantised Kokoro precision is now refused on WebGPU; fp32 stays.
  Found alongside: Kokoro pads each sentence with ~310 ms / ~490 ms of silence (ADR-27), and
  Chrome renders a silent AudioContext at 0.64× after ~30 s in a hidden page.
- **D-14 · Turn detection on real speech, no microphone** — done 2026-09-13, the done-when
  for P1-T07. Complete sentences end 168 ms median, 220 ms worst after the labelled end;
  found Smart Turn cutting sentences at inner pauses (ADR-25) and Moonshine's library token
  budget truncating one-to-two-second speech (fixed in `asr.worker.ts`).
- **D-13 · `speed` above 1.25 degrades** — found 2026-09-12 from Rick's ear, then measured.
  The server hits the requested duration ratio to within 7% up to 2.0, so **duration cannot
  detect the fault**: at 1.5 the audio carries 26.9 characters per second, past what the
  voice articulates, and words drop. Usable range ~0.75–1.25. The adapter keeps clamping to
  the API's own 0.25–4; a settings UI must not offer the full range as if it worked.
- **D-12 · Re-measure the first-chunk budget on a GPU server** — done 2026-09-12, the old
  C-6, and it **reversed a published conclusion**. On the GPU synthesis costs 1.29 ms/char,
  not 15.3 — 11.8x faster — so a 245 ms budget buys 178 characters rather than 17, and the
  full opening sentence reaches first audio in 137 ms rather than 1525. **ADR-20's budget
  is reachable at sentence granularity after all, and P1-T08 needs no first-chunk cap on
  this path.** `maxChars = 200` is untouched by any of it.
- **D-11 · `fp32` against `q8`, by ear** — done 2026-09-12, the old R-5. Rick could not tell
  the three pairs apart, matching the measurements. **The default stays `fp32` anyway**:
  C-5 ran on onnxruntime-node, the browser runs WebGPU, and ADR-20 already records
  transformers.js returning fluent nonsense with no error from a q8 graph on WebGPU. The
  quality question is closed; the deployment question moves to P1-T08.
- **D-10 · Compare Kokoro `fp32` against `q8`** — done 2026-09-12, the old C-5. No
  measurable difference in loudness, noise floor or high-frequency content between words;
  duration drifts up to 50 ms per utterance, which will move visemes. `q8` is 3.4x slower
  under onnxruntime-node, which says nothing about WebGPU. **Ears decide — see R-5.** Found
  in passing that `KOKORO_BYTES.q8` was quoting the wrong file (`model_q8f16.onnx`, 86.0 MB)
  where `dtype: 'q8'` actually fetches `model_quantized.onnx`, 92.4 MB — a consent screen
  understated by 6.3 MB, now corrected from the blob listing. Also that Kokoro's output
  exceeds full scale (peak 1.043), so P1-T08 must clamp.
- **D-9 · Is the TTS server using the GPU?** — no, it was on the CPU; diagnosed, fixed and
  **verified running on CUDA** 2026-09-12, the old C-4 and R-4. `torch 2.8.0+cu128 OK on
  NVIDIA GeForce RTX 5060 Ti (sm_120)`, and both device lines now agree on `cuda`. Every CUDA torch wheel in Kokoro-FastAPI's `pyproject.toml` is
  gated on `platform_machine == 'x86_64'`, and Windows reports `AMD64`, so the extra
  resolved to nothing and uv installed PyPI's CPU torch. The startup log cannot catch this:
  its first device line reports the `USE_GPU` env var without asking torch, and only the
  later `Loading Kokoro model on ...` line is real. `start-gpu.ps1` fixed to install the
  cu128 wheel explicitly and to fail on a real kernel launch. **Verify with R-4.**
- **D-8 · Add Fable to the Anthropic catalog** — done 2026-09-12. `claude-fable-5-1` added
  with every flag live-confirmed rather than inherited: it answered a question about an
  image, accepted `cache_control`, reports `thinking_tokens`, and streams text and tool
  calls. `claude-fable-5` deliberately left out as a previous point release.
- **D-7 · Measure `maxChars`** — done 2026-09-12. **200 stays.** Synthesis is 15.3 ms/char
  with no per-request overhead and runs 3.8x faster than speech, so chunk length cannot
  starve playback, and the cap does not touch the opening at all — 120, 200 and 320 give an
  identical first chunk. The real lever is a separate cap on the *first* chunk of a turn,
  which belongs to P1-T08.
- **D-6 · Accept ADR-22, 23, 24** — done 2026-09-12. No `proposed` ADRs remain. ADR-23 still
  obliges P1-T12 to decide explicitly whether to promote the tag shape into the protocol.
- **D-5 · Gemini context length** — done 2026-09-12. `GET /v1beta/models` reports
  `inputTokenLimit` 1048576 for all three catalog models, so `contextLength` is no longer
  `null`. The value is 2^20, not the round million — which is why it was never guessed.
- **D-4 · TTS against a real server** — done 2026-09-12 against Kokoro-FastAPI. 72 voices,
  24 kHz WAV decoded by `wav.ts`, RTF 0.25–0.41, `speed` honoured, errors passed through
  verbatim. Model id is `kokoro`, not `kokoro_v1`.
- **D-3 · Anthropic context lengths** — done 2026-09-12. `max_input_tokens` confirms all
  three catalog values (1M / 1M / 200K). The undated `claude-haiku-4-5` alias resolves.
- **D-2 · Live LLM streaming with a BYO key** — done 2026-09-12, the done-when for P1-T02
  and P1-T03. Nine endpoints, text and tool calls, all correct. Found that a thinking model
  can spend its whole budget reasoning and say nothing.
- **D-1 · Phase 0** — every spike run and every go/no-go call made, closed 2026-09-11 by
  P0-T09. The detail is in `docs/spikes/` and the ADR amendments.

### Earlier, from the old PROJECT.md backlog

Feedback API `presence` source and the Caddy proxy · Caddy sites for both domains · the
tunnel and MariaDB 11.8 check for Spike C · the `/gallery` click-through · `/spike/turn`
(eight runs, go at 100 ms / 0.7) · ADR-21 accepted · `/spike/avatar` (120.5 fps median) ·
the 1080p reading (unchanged at 1916×1076) · `DATABASE_URL` in `.env` · MariaDB 11.8.8 at
`192.168.40.101` · raising `mhnsw_max_cache_size` to 2 GiB, which was the whole finding of
Spike C · Fedora Tauri prerequisites · the Spike E Windows shell (go on WebView2) · one tray
click, which found the AppUserModelID trap · `pnpm i -g pnpm@12` on Windows.
