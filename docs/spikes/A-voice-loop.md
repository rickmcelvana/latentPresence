# Spike A — browser voice loop latency

**Status: done. Go, with three conditions — see the bottom.**
Task P0-T04. Brief: `docs/briefs/P0-T04.md`. Verified library facts: `docs/SURFACE.md`.

## The question

Can a browser do microphone → VAD → speech recognition → speech synthesis inside the
latency budget, with models the user downloads themselves? RESEARCH §3.3 targets **first
audio under 800 ms after end of turn**. No language model is in this loop — the
transcript is echoed straight back — so the number here is what is left for everything
around a model call. If this stage alone eats the budget, ADR-01 (browser-first) and
ADR-06 (cascaded pipeline) are both in question.

## What was built

`/spike/voice`, a dev-only route in `apps/web`. Throwaway measurement code; the real
pipeline is P1-T01 to P1-T08 behind the ports in `packages/protocol`.

| Stage | How |
|---|---|
| Capture | `getUserMedia` → `AudioContext` forced to 16 kHz → AudioWorklet emitting 512-sample frames |
| VAD | Silero v5 on `onnxruntime-web` in a worker; hysteresis 0.5 on / 0.35 off, 500 ms hangover, 300 ms pre-roll |
| STT | Moonshine tiny via transformers.js in a worker, `device` and `dtype` both explicit |
| TTS | Kokoro via `kokoro-js` in a worker, streamed per sentence |
| Output | `AudioContext` scheduling, first audio recorded when the first buffer is *scheduled to start* |

### Decisions that shaped it

- **transformers.js v3.8.1, not v4.2.0.** `kokoro-js@1.2.1` needs `^3.5.1`; taking v4 for
  recognition would ship two major versions of transformers, each with its own ONNX
  Runtime.
- **Silero runs directly on ORT, not through `@ricky0123/vad-web`.** That package pulls a
  different `onnxruntime-web` than transformers pins — a second runtime for a 2 MB model.
  ORT is pinned to the exact dev build transformers depends on, and that pin has to move
  with transformers or the duplication returns silently.
- **The VAD hangover is reported beside the latency, not inside it.** It is a tuning
  constant and the thing Spike D (P0-T07, Smart Turn v3) exists to shrink. Folding it in
  would make the pipeline look slower than it is and hide the number that matters.
- **First audio means scheduled to sound**, not "synthesis returned", which is a
  different and flattering number.

### Clock

One monotonic clock. The AudioWorklet cannot call `performance.now()`, so it reports the
`AudioContext` clock and the main thread converts with an offset measured once — marks
track the audio rather than when the main thread got round to looking. Marks that arrive
out of order, or a turn missing one, are reported as incomplete rather than turned into a
plausible number.

## Models downloaded

Behind an explicit consent screen (ADR-09): nothing is fetched until it is accepted.

| Model | Licence | q8 | fp16 |
|---|---|---|---|
| Silero VAD | MIT | 2.2 MB | 2.2 MB |
| Moonshine tiny | MIT | 28.2 MB | 91.8 MB |
| Kokoro 82M | Apache-2.0 | 92.4 MB | 163.2 MB |
| **Total** | | **122.8 MB** | **257.2 MB** |

Both backends run the same precision, or the comparison measures the quantisation rather
than the backend.

## Verified before the run

- The consent screen renders the sizes, licences and source links above, and switching
  precision changes both the per-model figures and the total.
- With the page open and the button untouched: **zero requests** for `huggingface.co`,
  and none for the ONNX Runtime, transformers or kokoro bundles either. The runtime was
  loading pre-consent at first — a constant shared with the worker module dragged ORT
  into the main graph — and was moved into `frames.ts` to stop it.
- The spike is **not** in the production build. A Rollup plugin in
  `apps/web/vite.config.ts` fails `pnpm build` if any chunk references the model
  libraries or a `.wasm` is emitted. Verified by removing the guard and watching the
  build fail, then restoring it. Before that guard existed, a production build shipped
  three worker chunks and a 21 MB ONNX Runtime wasm to a route nobody could open.

## Findings so far (2026-09-08)

From the first three runs on Rick's machine — Chrome, Arozzi Sfera Pro at 48 kHz
resampled to 16 kHz. These decide what P1 is allowed to build on, and they are what made
the timing runs possible; the timings themselves are under **Results**.

### Recognition: q8 is unusable on WebGPU

| Backend | Precision | Result |
|---|---|---|
| wasm | q8 | **Correct.** "What's the weather like today?", "Who owns that silver car?" |
| webgpu | fp32 | **Correct.** Same sentences, recognised cleanly |
| webgpu | q8 | **Broken.** The same string for every utterance: `"quartifies prconfirminé…"` with a tail that repeats as the utterance grows |
| webgpu | fp16 | **Will not load.** ONNX Runtime wasm exception |

Identical output for different audio is not a model guessing badly — the encoder result is
not reaching the decoder. Capture was excluded first: the buffer handed to the recogniser
plays back as clean speech, 31744 samples for 1984 ms (16 kHz exactly), RMS 0.1–0.26,
Silero confidence 0.97–1.00.

**Consequence for P1:** the browser STT provider cannot default to `q8` on WebGPU. Either
the backend is chosen per precision, or WebGPU takes fp32 and pays 109 MB for Moonshine
instead of 28 MB. Neither is free, and the choice needs to be explicit rather than left to
transformers.js, which defaults to q8 on wasm and fp32 on webgpu.

### Synthesis: kokoro-js `stream()` with a string never returns

Found by reading its `dist`, then fixed here: it builds a `TextSplitterStream`, pushes the
text and never closes it, so the iterator waits forever for input that cannot arrive. The
splitter is now constructed, pushed and closed on our side, which keeps per-sentence
streaming. Details in `docs/SURFACE.md`.

### The microphone hears the answer

Several transcripts contain the previous reply back again — "Who owns that silver car?
What's the weather like today? What's the weather like today?" — because the speakers were
open while the mic was live. Browser echo cancellation is on and does not cover an external
microphone next to speakers.

For measurement this has to be removed, not worked around: **the timing runs need
headphones**. For the product it is the real problem barge-in solves (P1-T08), and it is a
point in favour of doing that properly rather than by muting the microphone during
playback.

### Why the first runs produced no timings

A defect in this harness, not in the stack. Marks were held in one slot, and turns overlap
— someone speaks again while the previous answer is still playing — so a new `speech-start`
wiped the turn in flight and the two scrambled each other. Fifteen turns, fifteen
incomplete. The timing model refused to produce numbers from the wreckage, which is what it
is for, but the harness had to be fixed: every mark now carries a turn id from the VAD
through recognition and synthesis.

The playback queue had the same shape of bug. A new answer was scheduled behind the tail of
the previous one, so "first audio" would have measured how long the *last* reply was. A new
turn now takes the speaker over, which is what barge-in does anyway.

## Results

Ten turns per configuration, **zero incomplete**, every transcript correct. Four short
questions repeated in rotation, spoken into an Arozzi Sfera Pro switched to cardioid, on
headphones — the earlier runs had it omnidirectional beside open speakers and it was
transcribing its own replies. Raw logs in `docs/spikes/raw/`.

Only the two configurations that recognise correctly are timed. Timing webgpu / q8 would
measure a pipeline producing the wrong answer.

| | wasm / q8 | webgpu / fp32 |
|---|---|---|
| End of speech → first audio, median | **4397 ms** | **947 ms** |
| Worst | 4661 ms | 1225 ms |
| — of which VAD hangover | 512 ms | 512 ms |
| — of which recognition | 104 ms | 180 ms |
| — of which synthesis | 3779 ms | 245 ms |
| **Pipeline excluding the hangover** | **3885 ms** | **435 ms** |
| Model load, warm | STT 1399, TTS 1168 ms | STT 1681, TTS 1639 ms |
| Download | 122.8 MB | 436.9 MB |
| JS heap after | 19 MB | 17 MB |

Utterances were 2.2–2.7 s of speech; recognition and synthesis times are for one short
sentence, which is also the unit the sentence splitter will feed TTS in P1-T04.

### What the numbers say

**Synthesis is the whole story, and it needs a GPU.** Kokoro is 15× slower on wasm —
3779 ms against 245 ms. No amount of tuning closes that; an 82M-parameter vocoder is not a
CPU job. Recognition, by contrast, is comfortable everywhere, and *faster* on wasm/q8
(104 ms) than on webgpu/fp32 (180 ms): Moonshine tiny is small enough that GPU dispatch
overhead outweighs the compute, and the quantised graph is smaller to move.

**The hangover is the largest single component of the good configuration.** 512 ms of the
947 ms median is waiting to be sure the person stopped talking — it resolves at exactly
512 ms every time, because the 500 ms threshold is checked at the 32 ms frame boundary.
Actual pipeline work is 435 ms. That is the number to compare against the ~400 ms this
spike was given, and it is close enough to call viable.

**The 800 ms budget is not reachable as configured, and the LLM has not been added yet.**
947 ms already exceeds it with no model call in the loop. The arithmetic that matters:

- 435 ms of pipeline is fixed cost, on a GPU.
- That leaves 365 ms of the 800 for turn detection *and* an LLM producing enough tokens to
  start a sentence. A local model's first token alone is usually more than that.

So either turn detection gets much cheaper, or 800 ms is the wrong target.

## Go / no-go

**Go**, with three conditions that are now evidence rather than opinion.

1. **WebGPU is required, not preferred.** ADR-01 says browser-first; this says browser-first
   *with a GPU*. The wasm path works and is honest as a fallback, but at 4.4 s per turn it
   is not a conversation. A machine without WebGPU should be steered to a server TTS
   endpoint rather than left on wasm Kokoro — which is what the BYO provider design already
   allows, so nothing in ADR-06 has to change.

2. **Precision is chosen per stage, never inherited.** transformers.js defaults to q8 on
   wasm and fp32 on webgpu; the webgpu q8 path silently produces fluent nonsense. P1-T06's
   browser STT provider must set `dtype` explicitly and must not offer q8 on WebGPU.

3. **P0-T07 is now load-bearing, not optional.** The hangover is 54% of the good
   configuration's latency. Smart Turn v3 cutting end-of-turn detection to ~150 ms would
   bring first audio to roughly 600 ms with no other change, which is the difference
   between a demo and a conversation.

### Amendments this suggests

- ADR-06 stands. The cascaded pipeline is fast enough; nothing here argues for going
  omni-first.
- **The 800 ms target in RESEARCH §3.3 should be restated** as two numbers: under 500 ms
  from end of speech to first audio *excluding the model call*, and a separate end-to-end
  figure that depends on which LLM the user points at. One number covering both hides
  which part is the project's responsibility.

### Left untested

- **Mixed precision.** fp32 was used for both stages to get a clean comparison, which costs
  436.9 MB. Kokoro q8 demonstrably works on WebGPU — it synthesised fine in the broken-q8
  run, it was reading garbage text — so STT fp32 with TTS q8 would likely give the same
  latency for about 204 MB. Worth measuring before P1 picks defaults.
- **Cold load.** All load figures are warm, from browser cache. The first-run download of
  123–437 MB is unmeasured and is the number a new user actually experiences.
- **Memory.** 17–19 MB is the JS heap only; the models live in wasm memory, which this does
  not count. `performance.measureUserAgentSpecificMemory()` would, and was not wired up.
- **fp16 anywhere.** It will not load for Moonshine on WebGPU (ONNX Runtime wasm
  exception); Kokoro fp16 was never reached.
