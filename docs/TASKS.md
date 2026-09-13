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

### R-2 · Hear the character speak, in the app
**Why:** the plan's done-when for P1-T05. **Blocked until P1-T08** builds the AudioWorklet
output queue — there is nowhere to play audio today. The server adapter is already verified
against real bytes (see D-4), so what is left is genuinely the play-out path.

**Nothing to run yet.** This unblocks when P1-T08 lands; the command will be added here then.

### R-3 · Character pipeline
**Why:** P7. **Blocked on me** — waiting for `docs/pipeline/character.md`, which I owe you.
Includes replacing `apps/desktop/src-tauri/icons/`, currently Tauri's scaffold logo.

## Open — claude (say go, or add the key)

*Nothing runnable.* Three questions only a browser can answer, each waiting on the task that
first puts the pipeline in one:

- whether Kokoro `q8` is safe on **WebGPU**, worth 233 MB of every first run — a done-when on
  **P1-T08**, recorded in `docs/SURFACE.md` and on `dtype` in `kokoro-browser.ts`;
- **turn detection's latency on WebGPU on this onnxruntime version.** `live:turn` reproduces
  Spike D's 168 ms with Spike D's 40 ms answer latency applied; it did not measure that 40 ms
  again, because node has no WebGPU and `/spike/turn` is gone;
- **how often a human triggers ADR-25's retraction.** Kokoro pauses ~220 ms mid-sentence
  and a person may pause less, or more. Both of these belong to whichever task first opens
  the microphone in the app, and become an `R-` item with a command then.

## Done

Newest first. Each line is the outcome, not the instructions — the detail is in
`docs/SESSION-LOG.md` and the facts are in `docs/SURFACE.md`.

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
