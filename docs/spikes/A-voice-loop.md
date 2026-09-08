# Spike A — browser voice loop latency

**Status: harness built and verified; numbers pending a run on Rick's machine.**
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

## Results

**Pending.** To be filled in from a run on Rick's machine, per backend:

### WebGPU / q8

- Machine, browser, GPU:
- Microphone, device sample rate, graph sample rate:
- Model load (cold / warm):
- Turns (target ≥ 10), incomplete:
- **End of speech → first audio: median … ms, worst … ms**
- Of which: hangover … ms, STT … ms, TTS … ms (medians)
- JS heap after:

### WASM / q8

_(same fields)_

## Go / no-go

**Pending the numbers.** The write-up must say which stage is at fault if the budget is
missed, and must not report the WASM figure twice if WebGPU silently fell back.
