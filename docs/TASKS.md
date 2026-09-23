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

---

## Open — rick

### R-16 · Does she mean it? Emotes and gestures (P2-T07) · ~10 minutes
**Why:** the model's `[emote:…]` and `[gesture:…]` tags now move her face and head.
Whether the motions read right — and are the right size — is yours.

```bash
pnpm dev
```
1. `http://localhost:5173/dev/avatar` → agree → **Camera** `bust`. In **Gaze and clips**, pick each
   **Tag** and press **Play tag**: nod, shake-head, tilt-head, lean-in, shrug, think; then a few
   emotes (joy, concern, surprise, amusement). `wave` and `open-hands` say they need a clip.
   Too big, too small, wrong way?
2. `http://localhost:5173/chat` → **voice** call (typed replies are silent until P2-T08). She should
   show a feeling at the start of each answer and sometimes nod or tilt, and relax back after.

**Report:** per gesture and emote, fine / too much / too little / wrong; and whether the call felt
more alive or more fidgety.

### R-1 · Avatar frame rate on a different class of GPU
**Why:** every frame-rate number we have is from one RTX 5060 Ti. The interesting machine is
a worse one — a laptop, or anything with integrated graphics. Not urgent; nothing is blocked.

```bash
pnpm dev
```
Then open `http://localhost:5173/spike/avatar` on the other machine and let it run ~30 s.

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
pnpm build && pnpm exec vite preview --port 4173   # or: pnpm dev
```
Open `/chat`, press **Start voice**, agree to the download on the first call, and talk to her
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

### R-12 · Pick her animation clips (P2-T03) · **answered 2026-09-23** — pack in place, Blender 5.2 + VRM add-on + MCP installed

**Result.** The Standard pack is one file, `Unreal-Godot/UAL1_Standard.glb` (43 clips, CC0,
UE-style skeleton of 65 bones incl. fingers; `_RM` has root motion, the plain one does not —
use the plain one). **Rick: `Idle_Loop` (2.50 s) for `idle`**, and nothing in the free pack
fits the gestures — it is locomotion, combat and props. Read from the file: **`Idle_Talking_Loop`
(2.93 s) fits `talk`**, and `listen` reuses `Idle_Loop` (the life layer carries attention).
The eight gestures are **none** for now: head ones procedural as planned, the rest wait for a
second source (Pro pack or another CC0 library). `Sitting_Idle_Loop`/`Sitting_Talking_Loop`
exist, so sitting stays possible; **standing — Rick confirmed 2026-09-23.**

**Why:** P2-T03 is `human + sub`: you choose the clips, I write the Blender script that
retargets them onto a VRM and exports `.vrma` (the format the renderer loads), plus the
runtime blend graph. Nothing here is code. About 30–45 minutes, most of it browsing.

**1 · Download the pack (free).** Quaternius **Universal Animation Library**, CC0 —
https://quaternius.itch.io/universal-animation-library → *Download Now* → enter **0** (or
anything) → **Standard** (15 MB). *Pro* ($9.99+) only adds more clips; *Source* ($14.99+) adds
the `.blend` — neither is needed. Unzip it to:
```
Z:\_dev\latentPresence\assets\clips\source\
```
That folder is gitignored: the pack stays on your machine, and only the retargeted `.vrma`
files and a manifest get committed.

**2 · Choose the clips.** Browse them in the viewer at https://quaternius.com/animviewer.html,
and fill this in with the clip names exactly as the pack spells them (one per slot; two if
you like both — "none" is a fine answer):

| slot | what it is for | your pick |
|---|---|---|
| `idle` | standing, doing nothing, loops — the base of everything | |
| `listen` | idle while you talk: attentive, a little still | |
| `talk` | idle while she talks: light movement, loops | |
| `wave` | hello / goodbye | |
| `shrug` | "I don't know" | |
| `open-hands` | explaining, presenting | |
| `think` | hand to chin, or looking up | |
| `lean-in` | interest | |
| `nod`, `shake-head`, `tilt-head` | head only — **probably not in the pack**; if not, I do these procedurally, like the life layer's head | |

Those eight gestures are the `[gesture:…]` tags the model can write (`CharacterGestureSchema`).
Avoid clips that walk, turn or travel — she stays on her mark.

**3 · Standing or sitting?** Everything so far assumes **standing** — the life layer shifts her
weight between legs, and P2-T05's "full" camera preset shows her whole. Sitting at the desk is
the other option and changes which clips fit. **Recommended: standing.** Say if you want sitting.

**4 · Install Blender** (the script runs it headless; you only open it once). Blender **4.2 or
later** from https://www.blender.org/download/ — the VRM add-on supports up to 5.2. Then the
add-on: start Blender → **Edit → Preferences → Get Extensions** → if asked, **Allow Online
Access** → search **VRM** → **VRM format** → **Install**. (Offline alternative: download the
zip from the Blender Extensions Platform, **do not unzip it**, and use **Add-ons → ˅ → Install
from Disk**.)

**Report:** the filled-in table, standing or sitting, and the Blender version you installed.

### R-3 · Character pipeline
**Why:** P7. **Blocked on me** — waiting for `docs/pipeline/character.md`, which I owe you.
Includes replacing `apps/desktop/src-tauri/icons/`, currently Tauri's scaffold logo.

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
