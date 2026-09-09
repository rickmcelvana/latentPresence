# Spike D — Smart Turn v3 in the browser

**Status: done. Go, on fp32/WebGPU at a 100 ms candidate and a 0.7 threshold.**
Task P0-T07. Brief: `docs/briefs/P0-T07.md`. Verified library facts: `docs/SURFACE.md`.
Raw logs: `docs/spikes/raw/D-runs-2026-09-08.md`.

## The question

Spike A measured 947 ms from end of speech to first audio on WebGPU, and **512 ms of it
was the VAD hangover** — silence, waited through to be sure the person had stopped. That
is 54% of the latency, and the only part of it that is a guess rather than work.

Smart Turn v3 judges whether the *sentence* sounds finished instead of counting silence.
The question is whether it can do that in a browser, fast enough to be worth it, without
interrupting people mid-thought.

## What was built

`/spike/turn`, a second dev-only route beside Spike A's, dropped from production builds by
the same plugin in `apps/web/vite.config.ts`. It **reuses Spike A's capture and VAD**.

The VAD runs with a short *candidate* silence. Every pause past it, the utterance so far
goes to the model; a probability over the threshold ends the turn there. Spike A's 500 ms
hangover stays as the backstop, so a turn always ends whether or not the model fires — and
which of the two closed it is the result. Every utterance is labelled **before** it is
spoken, complete or incomplete, and the label is fixed at `speech-start`.

Two things the harness refuses to do: report a probability from a feature block that is
not a Whisper log-mel (the clamp makes the block span exactly 2.0, checked every
inference), and average a false fire into a single accuracy figure. Interrupting someone
and falling through to the timer are different mistakes, so the matrix keeps four cells.

## Results — 2026-09-08, Rick's machine

Eight runs: four build/backend combinations at two settings, twenty labelled utterances
each — ten finished sentences, ten trailed off mid-thought and held. Arozzi Sfera Pro,
Chrome, NVIDIA Blackwell.

### Latency

| Build / backend | Candidate 200 ms, threshold 0.5 | Candidate 100 ms, threshold 0.7 |
|---|---|---|
| gpu (fp32) / **webgpu** | 273 ms median, 311 worst | **168 ms median, 224 worst** |
| gpu (fp32) / wasm | 469 ms median, 480 worst | 376 ms median, 473 worst |
| cpu (int8) / webgpu | will not load | will not load |
| cpu (int8) / wasm | 392 ms median, 408 worst | 301 ms median, 433 worst |

Against Spike A's 512 ms hangover, the recommended configuration answers in **168 ms** —
**344 ms saved**, and the worst case still beats the old median by nearly 300 ms.

The split at 100 ms / 0.7 on WebGPU: 128 ms of candidate silence, 22 ms of log-mel, 14 ms
of inference, the rest scheduling. **The wait is now nearly all deliberate silence rather
than work**, which is a much better place to be: it is a dial, not a cost.

### Accuracy

Pooled over the six runs that produced probabilities — same speaker, same script:

| | fired | held off |
|---|---|---|
| complete (60) | 50 | 10 |
| incomplete (61) | **2** | 59 |

- **False fire — interrupting a pause — 2 of 61, 3.3%.** Both were in the first run, and
  none of the five later runs fired on a single incomplete utterance: **0 of 51**.
- Miss — a finished sentence falling through to the timer — 10 of 60, 17%. A miss costs
  the 512 ms already being paid today, so it is a disappointment rather than a regression.

**The separation is the striking part.** Finished sentences score 0.70–0.99; trailed-off
ones score 0.005–0.03 almost without exception. In the recommended configuration the ten
incomplete utterances scored 0.005, 0.005, 0.005, 0.005, 0.005, 0.006, 0.006, 0.006,
0.007, 0.023. That is not a model hedging near a threshold — it is a model that is sure,
and it means the exact threshold matters much less than it might have.

The recommended configuration on its own: **9 of 10 complete fired, 0 of 10 incomplete
fired**, one miss at p=0.490.

### The twenty-first turn

The first run recorded twenty-one turns where twenty were spoken, and Rick recalls a bell
in the background. The count fits, and the run is an outlier in exactly the way that
suggests: it holds the only two false fires of the evening (0.851 and 0.926) and the only
incomplete readings above 0.03 apart from two isolated cases elsewhere.

**The log cannot say which row it was.** Nothing about the audio was recorded per turn, so
a bell and a sentence look identical in the table. If the spurious turn is one of the two
fires, that run's false-fire rate was 1 in 10; if it is one of the nine that held off, it
was 2 in 10. Either way it does not move the recommendation, which rests on the five later
runs and their 0 of 51.

That gap is now closed: the VAD already computed duration, RMS, peak and max p(speech) for
its `settled` message, and candidates carry them too. The next spurious turn will be
identifiable — a bell is short and peaky and not very speech-like — instead of remembered.

### Two answers that arrived too late

`probability 0.979 arrived for turn 1, already closed`, twice, both on wasm, both on the
cold first turn. The model had judged the sentence finished; the answer arrived after the
512 ms backstop had closed the turn, and the matrix recorded both as misses.

That is a backend problem wearing an accuracy problem's clothes. On wasm, a 224 ms
candidate plus a 222 ms inference leaves under 70 ms of headroom before the timer, and the
first inference is cold. Those turns are now recorded as `late` — credited as fires in the
matrix, kept out of the latency medians, and counted separately. The pooled figures above
already treat them that way.

### int8 does not load on WebGPU, on real hardware too

Twenty consecutive `[WebGPU] Kernel "[DequantizeLinear] ... In the case of dequantizing
int32 there is no zero point"` errors, matching the bench exactly. It fails loudly rather
than returning nonsense, which is the opposite of Spike A's Moonshine q8 and the reason
this cost minutes instead of an evening. The int8 build works on wasm — 150 ms an
inference — but it is a different graph with different opinions (`docs/SURFACE.md`), so it
is a fallback for a machine without a GPU, not a cheaper default.

### What cannot be concluded

Each run is a **separate take** of the same script, so accuracy differences *between* runs
are mostly what was said, not the configuration. The bench established that fp32 gives
identical probabilities on wasm and WebGPU, so the gap between those two rows is speech,
not backend. Latency is the thing that compares cleanly across runs.

## What this does to the 947 ms

Spike A: 947 ms = 512 ms hangover + 435 ms of pipeline (recognition 180, synthesis 245).
Replacing the hangover with a 168 ms answer, run sequentially:

```
168 ms  end of speech to "the turn is over"
180 ms  recognition
245 ms  synthesis to first audio
------
593 ms  first audio, still with no language model in the loop
```

**But turn detection and recognition do not have to be sequential.** They consume the same
buffered window and neither depends on the other, so both can start when the candidate is
cut. Turn detection takes 40 ms of work after that point; recognition takes 180 ms. Running
them together:

```
128 ms  candidate silence
180 ms  recognition (turn detection finishes inside this, at 40 ms)
245 ms  synthesis
------
553 ms  first audio
```

The cost is a speculative recognition pass per candidate that turns out not to end the
turn — median one candidate per turn, so usually the pass you keep. **This is a design
implication, not a measurement**; it needs its own verification in P1. It is written up as
**ADR-21 (proposed)**, along with the question it forces: ADR-20's 500 ms pipeline budget
was measured with the hangover carved out as a tuning constant, and turn detection is no
longer a tuning constant. Counted honestly, the best measured path is **553 ms against a
500 ms budget** — 53 ms over, with the candidate silence the obvious dial.

## Go / no-go

**Go.** Smart Turn v3 replaces the VAD hangover.

1. **fp32 on WebGPU, 100 ms candidate, 0.7 threshold.** 168 ms median, 344 ms faster than
   the hangover it replaces, and it did not interrupt a single one of the ten held pauses.
2. **The false-fire risk this spike existed to size is small.** 0 of 51 across the five
   later runs, and the probability separation is wide enough that the threshold is not a
   knife edge. The 3.3% pooled figure is carried by one run that also contains an utterance
   nobody spoke.
3. **The remaining latency is deliberate silence, not work.** 128 of the 168 ms is the
   candidate window. Shortening it is the next lever, and it can be pulled without
   touching the model.
4. **int8 is a no-GPU fallback, not a cheaper default.** It will not run on WebGPU at all,
   and its probabilities differ from fp32's by enough to need their own threshold.

### Left untested

- **A candidate shorter than 100 ms.** 60–80 ms would take the answer under 130 ms; the
  risk is more candidates per turn and more chances to fire inside a word.
- **Overlapped recognition**, above. The arithmetic is sound; the implementation is P1's.
- **Anyone but Rick, and any language but English.** The model's own benchmark reports
  94.3% on English and as low as 79% on Vietnamese, so a second speaker is worth a session
  before this is called settled for everyone.
- **Barge-in interaction.** The 500 ms hangover is still the backstop here. Whether it
  stays at all once P1-T08 handles interruption is a P1 question.
