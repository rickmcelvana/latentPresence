# Session log

Append-only. Newest at the bottom. Five lines per entry. Prune entries older than 30 into `docs/archive/`.

## 2026-09-07 claude — planning session 1
Did: researched landscape (avatar tech, speech stack, memory, platform); wrote RESEARCH, DECISIONS (13 proposed ADRs), PLAN, LLM-PLAN, WORKFLOW, Aider template, CLAUDE.md, PROJECT.md, README.
Left: all ADRs are `proposed`; no code yet.
Next: Rick reviews RESEARCH §2 and §8 and the open questions in PROJECT.md; then P0-T01 monorepo scaffold.
Decisions: none accepted yet.

## 2026-09-07 claude — planning session 2
Did: renamed to latentPresence (ADR-19); accepted ADR-01..13 from Rick's answers, amended 07 (Windows first) and 13 (architect edits, gate, commit on green; Aider optional); added ADR-14 schedules, 15 design system (teal), 16 hosting, 17 remote dev DB, 18 Alice; added tasks P0-T02b, P6-T07/08, P8-T05; rewrote WORKFLOW from the latentCreate loop.
Left: no code. Rick's backlog in PROJECT.md (feedback API source, Caddy, tunnel check).
Next: P0-T01 monorepo scaffold, then P0-T02 and P0-T02b.
Decisions: 19 ADRs accepted.

## 2026-09-08 claude — P0-T01, P0-T02, P0-T02b
Did: monorepo scaffold with pnpm workspaces, TS7/Vite 8/React 19, cargo companion with axum /health, `pnpm gate` and CI (cce86f0, CI green on first push); protocol package — data schemas then ports, companion route table, README (995ea32, c954de9); design system, /gallery dev route, theme tests ported from latentCreate plus the no-colour-literal test (d1e27f8). 93 TS tests, 2 Rust tests, gate green.
Left: Rick's click-through of /gallery. `apps/desktop`, `site/` and `assets/` not created (their own tasks). Gallery is dev-only, so Playwright screenshots will need the dev server.
Next: P0-T03 site skeleton and deploy script (owner: aider — architect writes the brief first), or P0-T04 Spike A if Rick prefers spikes first.
Decisions: none proposed. Three judgement calls recorded in the commits — packages are `emitDeclarationOnly` because TS refuses `noEmit` on a referenced project (TS6310); pnpm 11's `minimumReleaseAge` protection kept, with oxlint pinned behind the window rather than excluded; token names follow latentCreate (`--bg`, `--text-muted`) rather than ADR-15's prose, values unchanged.
Click-through: pending — `pnpm dev`, then http://localhost:5173/gallery

## 2026-09-08 claude — P0-T03 site skeleton
Did: wrote the P0-T03 brief with the feedback API contract verified against the running service (SURFACE.md); designed a mark of its own for latentPresence, teal, six PNGs from one SVG master (2326319); reviewed Rick's Aider run and fixed five defects (9900e87, 8909dd1) — deploy.sh died on every run from a doubled backslash in an eval, its own test resolved the site root one level too high so nothing ran, four colour literals sat outside :root, and `.reveal` hid content unconditionally so the page was blank without JS. 107 TS + 2 Rust tests, gate green.
Left: `app.latentpresence.com` has no build behind it yet. The five Phase 0 spikes are untouched.
Next: P0-T04 Spike A, browser voice loop latency (architect-direct).
Decisions: ADR-16 amended — the server deploys by `git pull` then `pnpm build`, not rsync, so scripts/deploy.sh was deleted the day it was written and the DEPLOY_* variables left .env.example.
Click-through: passed 2026-09-08 (/gallery, and the live site, docs and feedback form — a submission arrived tagged `App: Latent Presence`).

## 2026-09-08 claude — P0-T04 Spike A
Did: built the voice-loop harness at /spike/voice (consent screen, three workers, per-turn timing) and measured it with Rick at the microphone. Twenty clean turns: **947 ms end of speech to first audio on WebGPU/fp32**, of which 512 ms is the VAD hangover, against 4397 ms on wasm where Kokoro takes 3779 ms. Found four real problems on the way: q8 recognition returns the same fluent nonsense for every utterance on WebGPU, kokoro-js `stream()` given a string never returns, the production build was shipping 21 MB of ONNX Runtime for an unreachable route, and my own marks were kept in one slot while turns overlap. Write-up in `docs/spikes/A-voice-loop.md`.
Left: mixed precision untested (fp32 costs 437 MB; Kokoro q8 works on WebGPU, so ~204 MB is likely). Cold-load and wasm-memory figures unmeasured.
Next: P0-T07 Spike D, promoted ahead of B and C — the hangover is 54% of the latency, so turn detection decides whether the target is reachable.
Decisions: **ADR-20 accepted** (Rick, same day) — WebGPU required for synthesis, precision chosen per stage never inherited, and the single 800 ms target replaced by two numbers because one figure hides which half the project owns. RESEARCH §3.3 and `docs/PLAN.md` now follow it, and the spike harness measures against the 500 ms pipeline budget.
Click-through: n/a — Rick ran the spike directly and supplied the numbers.

## 2026-09-08 claude — P0-T07 Spike D
Did: verified the Smart Turn v3 input surface by reading both ONNX graphs and pipecat's `inference.py` — 80 mel bins by 800 frames, not the 128 by 3000 a summary of the model card claimed, and the audio is front-padded and waveform-normalised, neither of which transformers.js does. Built the harness at `/spike/turn` reusing Spike A's capture and VAD (new optional `candidateMs` on the VAD worker; defaults unchanged, so Spike A stays reproducible), then benched all four build/backend combinations on synthetic audio. **fp32 on WebGPU: 8 ms an inference, 38 ms for the log-mel, identical probabilities to its own wasm run.** int8 on WebGPU will not load (DequantizeLinear kernel error — loudly, unlike Moonshine q8). 27 new tests, 121→148 TS, gate green.
Left: the labelled run. Ten complete and ten incomplete utterances with a microphone and headphones is what decides go/no-go; everything measured so far is cost, not correctness on speech. Also worth a second pass at threshold 0.7 and a 100 ms candidate.
Next: Rick runs `/spike/turn`; then P0-T05 Spike B or P0-T06 Spike C.
Decisions: none proposed. Two judgement calls in the commits — the page defaults to fp32/WebGPU on the strength of the bench rather than to the cheap download, and int8 and fp32 disagree on the same audio by enough to cross the threshold in both directions, so the builds are recorded as not interchangeable.
Click-through: pending — `pnpm dev`, then http://localhost:5173/spike/turn, per `docs/spikes/D-smart-turn.md` "Outstanding".

## 2026-09-08 claude — P0-T07 Spike D closed
Did: took Rick's eight runs (`docs/spikes/raw/D-runs-2026-09-08.md`) and closed the spike. **Go**: fp32/WebGPU at a 100 ms candidate and 0.7 threshold answers in **168 ms** against the 512 ms hangover, and interrupted **0 of 51** held pauses across the five runs after the first — finished sentences score 0.70–0.99, trailed-off ones 0.005–0.03, so the threshold is not a knife edge. int8 on WebGPU failed twenty for twenty with the DequantizeLinear error, exactly as benched. Fixed two harness defects the run exposed and re-wrote the write-up.
Left: a candidate under 100 ms is untested, as is overlapped recognition and any speaker but Rick. The 21st turn in run 1 could not be attributed — that is why the stats change went in.
Next: P0-T05 Spike B or P0-T06 Spike C.
Decisions: **ADR-21 proposed** — turn detection now counts inside ADR-20's 500 ms pipeline budget (it is no longer a tuning constant), and the budget stays at 500 rather than being restated to fit the measured 553 ms; the two levers that close the gap, overlapping recognition and a shorter candidate, are real and unexercised. Recommended option taken; Rick to confirm.
Click-through: passed 2026-09-08 — Rick ran all eight configurations directly.

Two things the run caught in my own harness, both now fixed and tested. `probability 0.979 arrived for turn 1, already closed` appeared twice, both on wasm, both cold: the model had judged the sentence finished and its answer arrived after the 512 ms backstop, and the matrix booked both as misses — blaming the model for a backend problem, since a 224 ms candidate plus a 222 ms inference leaves under 70 ms of headroom. Those are now `late`: a fire for judgement, out of the latency medians, counted separately. And the first run recorded twenty-one turns where twenty were spoken (Rick recalls a bell), which nothing in the record could confirm because no per-turn audio detail was kept; candidates now carry the duration, RMS, peak and max p(speech) the VAD was already computing.

## 2026-09-09 claude — ADR-21 accepted, then P0-T05 Spike B
Did: followed ADR-21 through DECISIONS, PROJECT, PLAN, RESEARCH, LLM-PLAN and the Spike D write-up after Rick accepted it — P1-T07 loses "or adaptive silence" and P1-T06 gains the consequence that recognition must tolerate being cancelled mid-transcription. Then took P0-T05 over P0-T06, because Spike C has neither `.env` nor Docker on this box and cannot produce a number. Verified the avatar stack against the npm registry and the asset files themselves, and built `/spike/avatar`: r3f scene, consent, frame-rate model, and the viseme mapping in `packages/avatar`. 173 TS tests, gate green.
Left: **the frame-rate run**. The browser pane this session had is hidden, and a hidden page neither runs `requestAnimationFrame` nor delivers `ResizeObserver` callbacks — which produced two convincing symptoms (a canvas stuck at 300×150, a frame window that never filled) that were chased to the environment rather than written up as page bugs. Spike C stays blocked.
Next: Rick runs `/spike/avatar` in a real Chrome window; then P0-T06 once `.env` or Docker exists.
Decisions: **ADR-21 accepted** (Rick). None proposed. Three judgement calls in the commits — the sample VRM is fetched at run time rather than committed because it carries the VRM Public License 1.0 and not CC0/CC-BY as ADR-11 asks; `three` is pinned to 0.185.1 rather than the newest, which is inside pnpm's release-age window; and the viseme mapping went into `packages/avatar` rather than the spike because P2 keeps it.
Click-through: pending — `pnpm dev`, then http://localhost:5173/spike/avatar in a normal Chrome window.

Two things worth keeping. wawa-lipsync emits the fifteen Oculus visemes, not VRM's five, and nine of them have no VRM mouth shape at all — the plan entry assumed the library drove `aa/ih/ou/ee/oh` directly. The mapping is now a table with the reason on every line, held in place by a `satisfies Record<OculusViseme, Viseme>` so a sixteenth viseme fails the build rather than silently falling through to silence. And Chrome ignores `powerPreference` in `requestAdapter()` on Windows (crbug 369219127), so the integrated-versus-discrete comparison the brief asked for may not be possible on this machine at all; the write-up says so rather than printing the discrete number twice.
