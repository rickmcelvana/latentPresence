# Spike D — Smart Turn v3 in the browser

**Status: harness built and benched; the labelled run on Rick's machine is outstanding.**
Task P0-T07. Brief: `docs/briefs/P0-T07.md`. Verified library facts: `docs/SURFACE.md`.

## The question

Spike A measured 947 ms from end of speech to first audio on WebGPU, and **512 ms of it
was the VAD hangover** — silence, waited through to be sure the person had stopped. That
is 54% of the latency, and the only part of it that is a guess rather than work: the
pipeline itself is 435 ms, inside ADR-20's 500 ms budget.

Smart Turn v3 is a semantic endpointer: it judges whether the *sentence* sounds finished
instead of counting silence. If it can answer in a browser well inside 512 ms, first audio
comes down with no other change. If it cannot, P1-T07 ships adaptive silence and this
document says what that design is.

## What was built

`/spike/turn`, a second dev-only route beside Spike A's, dropped from production builds by
the same plugin in `apps/web/vite.config.ts` (now covering both spikes). It **reuses Spike
A's capture and VAD** rather than growing its own copies.

| Piece | What it does |
|---|---|
| `vad.worker.ts` | Unchanged by default. New optional `candidateMs` emits a `candidate` — the utterance so far, capped at 8 s — after a *short* silence without closing the turn, and `end-turn` lets the page take the turn early |
| `turn-audio.ts` | The preprocessing transformers.js does not do: last 8 s, zero-pad at the **front**, zero-mean unit-variance over the whole padded window |
| `smart-turn.worker.ts` | `WhisperFeatureExtractor(chunk_length=8)` built from an inline config, then onnxruntime-web |
| `turn-metrics.ts` | Detection latency, the confusion matrix, and the probability spread |
| `TurnDetect.tsx` | Consent, configuration, the label control, results, Markdown export |

**How a turn ends.** The VAD runs with a short candidate silence (200 ms by default). Every
pause past it, the utterance goes to the model; a probability over the threshold ends the
turn *there*. Spike A's 500 ms hangover stays as the backstop, so a turn always ends even
if the model never fires — and which of the two closed it is most of the result.

### Two things the harness refuses to do

- **Report a probability from a feature block that is not a Whisper log-mel.** Whisper's
  final clamp, `(max(x, x.max() - 8) + 4) / 4`, makes the block span exactly 2.0 for any
  input that is not perfectly flat. The worker checks that and the dims on every inference
  and discards the probability if either fails. Spike A's q8 bug produced fluent, wrong
  output that nothing in the harness could see; this is the version of that check that
  runs on the machine taking the measurement.
- **Average a false fire into an accuracy figure.** Interrupting someone mid-sentence and
  falling through to the timer are different mistakes — one is a regression, the other is
  what already happens today — so the matrix keeps four cells and each rate is taken over
  its own label.

Every utterance is labelled **before** it is spoken, complete or incomplete, and the label
is fixed at `speech-start` rather than at the end.

## Bench, 2026-09-08 — architect, synthetic audio

Run through the dev preview to answer the question `docs/SURFACE.md` had left open —
*whether either build runs under onnxruntime-web at all* — before Rick spends an evening
on a microphone. Six deterministic pseudo-speech clips, 2.5 s each, identical across all
four configurations, twelve inferences each, medians of the warm pass.

**This is not the spike's result.** Synthetic audio says nothing about whether the model
endpoints real speech correctly. It says what the thing costs and whether it works.

Chromium 152 (the Claude desktop app's browser, not Chrome), Windows 11, 16 cores,
NVIDIA Blackwell.

| Build | Backend | Load | Features | Inference | Probabilities on the six clips |
|---|---|---|---|---|---|
| cpu (int8) | wasm | 528 ms | 31 ms | **153 ms** | 0.799, 0.375, 0.107, 0.559, 0.911, 0.500 |
| cpu (int8) | webgpu | — | — | — | **will not load** |
| gpu (fp32) | wasm | 744 ms | 32 ms | 222 ms | 0.831, 0.106, 0.014, 0.142, 0.723, 0.790 |
| gpu (fp32) | **webgpu** | 996 ms | 38 ms | **8 ms** | 0.831, 0.106, 0.014, 0.142, 0.723, 0.790 |

Loads are warm, from browser cache. The first cold load of the int8 build was 1080 ms.

### It runs, and the fast path is very fast

fp32 on WebGPU is **8 ms** an inference — nineteen times quicker than int8 on wasm, and
the graph's own `input_features` → `logits` names came back exactly as the offline read of
the protobuf said they would.

**Feature extraction is not the bottleneck.** 31–38 ms for an 800-frame Whisper log-mel in
JavaScript was the thing most likely to sink this, and it did not. No Rust companion is
needed for turn detection.

### The WebGPU path is correct, not merely fast

fp32 on WebGPU returned probabilities **identical to fp32 on wasm** on all six clips. That
is the cross-check Spike A had to invent after the fact: same graph, two backends, same
answers. Whatever this model gets wrong, it is not getting it wrong because of WebGPU.

### int8 on WebGPU fails loudly, which is a mercy

```
[WebGPU] Kernel "[DequantizeLinear] inner.encoder.conv1.bias_DequantizeLinear" failed.
Error: In the case of dequantizing int32 there is no zero point.
```

It refuses to load rather than returning nonsense. Spike A's Moonshine q8 on WebGPU
produced confident garbage for every utterance and cost an evening to find; this one says
so. The combination is still worth knowing about because it is the one a naive "quantised
is smaller, WebGPU is faster" default would pick.

### int8 and fp32 do not agree, and the difference crosses the threshold

Same audio, same preprocessing, different answers: 0.375 against 0.106, 0.559 against
0.142, 0.500 against 0.790. Two of those land on opposite sides of the 0.5 cut-off.

On synthetic clips this is not an accuracy claim — neither column is "right". What it does
say is that **the two builds are not interchangeable**: a threshold tuned on one does not
carry to the other, and the 8.7 MB download is not a free substitute for the 32.4 MB one.
Since fp32 on WebGPU is also the fastest path by a factor of nineteen, the cheap download
only matters for a machine with no GPU — which is precisely where Spike A already said to
use a server.

### What this does to the 947 ms, on these numbers

With a 200 ms candidate silence, fp32 on WebGPU:

```
200 ms  candidate silence
 38 ms  log-mel
  8 ms  inference
~10 ms  two port hops and scheduling
------
~256 ms  end of speech to an answer, against 512 ms of hangover
```

947 − 512 + 256 ≈ **690 ms** to first audio, still with no language model in the loop.
A 100 ms candidate would put it near 590 ms. Both are subject to the accuracy result
below, which is the part that decides whether any of it is usable.

## Outstanding — the labelled run

Everything above is cost. None of it is correctness on speech, and correctness is what
decides this spike. What is left needs a person, a microphone and headphones:

1. **Ten complete and ten incomplete utterances**, minimum, per configuration, labelled
   before speaking. The incomplete ones are the point: a real mid-sentence pause, trailed
   off and held, which is exactly what a silence timer gets wrong.
2. **The false-fire rate** — how often the model interrupted a pause. This is the number
   the go/no-go turns on. A model that never interrupts and saves 256 ms is a win; one
   that interrupts one pause in five is worse than waiting.
3. **The miss rate**, for completeness. A miss costs the 512 ms already being paid.
4. Worth a second pass at **threshold 0.7 and candidate 100 ms** — both are adjustable on
   the page and every probability is recorded, so a second run can answer "what would a
   different threshold have done" without re-speaking anything.

Run at `/spike/turn` under `pnpm dev`. The page defaults to fp32 / WebGPU on the strength
of the bench; the other three stay selectable.

## Go / no-go

**Not yet decided.** What can be said on evidence:

- **It runs in a browser, comfortably.** 8 ms an inference and 38 ms of feature extraction
  on a GPU. The technical risk this spike existed to retire is retired.
- **The preprocessing was the real hazard, and it is handled.** Front-padding and waveform
  normalisation are both absent from transformers.js and both silent when wrong
  (`docs/SURFACE.md`).
- **Whether it is *better* than waiting 512 ms is unanswered**, and cannot be answered with
  synthetic audio. If the false-fire rate on real pauses is low, ADR-20's arithmetic
  improves by roughly 256 ms. If it is not, P1-T07 ships adaptive silence and this document
  gains that design.
