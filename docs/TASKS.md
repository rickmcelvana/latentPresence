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

`live:tts` also writes playable WAVs to `packages/providers/live/out/` (gitignored),
re-encoded from what our own decoder produced — so if they sound right, the adapter is
right.

---

## Open — rick

### R-1 · Avatar frame rate on a different class of GPU
**Why:** every frame-rate number we have is from one RTX 5060 Ti. The interesting machine is
a worse one — a laptop, or anything with integrated graphics. Not urgent; nothing is blocked.

```bash
pnpm dev
```
Then open `http://localhost:5173/spike/avatar` on the other machine and let it run ~30 s.

**Expect:** the page prints a frame-rate table (median, 5th percentile, worst frame).
**Report:** paste the table plus the GPU name. `docs/spikes/B-vrm-lipsync.md` gets the row.

### R-5 · Configure Ollama and NVIDIA from the settings page, without docs
**Why:** P1-T10's done-when is "a new user can configure Ollama and NVIDIA without reading
docs". I checked every screen state in the Browser pane, but typing a real API key into a
page is yours, and so is judging whether the words on screen are enough. Try not to read
this block past step 2.

```bash
pnpm dev
```
1. Open `http://localhost:5173/settings`.
2. **Ollama:** pick it, get to a model that answers **Send a test message**.
3. **NVIDIA:** pick it, save your key, and get to a reply. The page will tell you about the
   companion; follow what it says.
4. Reload the page and check both choices and the saved key are still there (the key shows
   as "Key saved", never its text).

**Report:** where you hesitated or had to guess, any message that was wrong or unclear, and
how long each took. If the NVIDIA test message failed, paste the message the page showed.

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
