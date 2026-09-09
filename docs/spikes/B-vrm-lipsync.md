# Spike B — VRM avatar and lip sync

**Status: done. Go — measured at the resolution the budget is written against.**
Task P0-T05. Brief: `docs/briefs/P0-T05.md`. Verified library facts: `docs/SURFACE.md`.

## The question

ADR-03 puts a full-body semi-realistic VRM 1.0 avatar in three.js behind an
`AvatarRenderer` interface, on the assumption that a browser can drive one at a
conversational frame rate while the voice pipeline is also running. Phase 2 builds the
stage on it and Phase 7 builds a character pipeline feeding it, so if the frame rate is
not there, both change shape.

## What was built

`/spike/avatar`, a third dev-only route, guarded the way Spikes A and D are — the early
return before the dynamic import, plus the forbidden-substring plugin in
`apps/web/vite.config.ts`. **The two entries added there, `@pixiv/three-vrm` and
`three/examples/jsm`, are the ones P2-T01 deletes on purpose**: the avatar stops being
dev-only the moment the stage is real, and that is the one line of the guard meant to come
out rather than stay forever.

| Piece | What it does |
|---|---|
| `packages/avatar/src/visemes.ts` | Oculus → VRM mapping, weight clamping, frame-rate-independent smoothing. **Not throwaway** — P2 keeps it |
| `apps/web/src/spikes/frame-rate.ts` | Median, 5th percentile, worst frame, and a refusal to report from too few |
| `apps/web/src/spikes/avatar-consent.ts` | What is downloaded, and under which licence |
| `apps/web/src/spikes/AvatarStage.tsx` | The react-three-fiber scene and the page |

## The mapping, which is the part that outlives the spike

`wawa-lipsync` reports the **Oculus/ARKit viseme set — fifteen shapes**. VRM 1.0 has five
mouth expressions plus silence, which is also what `VisemeSchema` in `packages/protocol`
says. **Nine of the fifteen have no VRM equivalent.** The plan entry assumed the library
would drive `aa/ih/ou/ee/oh` directly; it does not, and pretending otherwise is how an
avatar ends up looking like it is chewing.

The rule used throughout: **approximate the nearest mouth *shape*, not the nearest sound.**
A viewer is watching lips, not listening to phonemes — they cannot see the difference
between /p/ and /b/, but they can see a mouth that stays open through a word that closes.

| Oculus | VRM | Why |
|---|---|---|
| `sil` | `sil` | — |
| `PP` | `sil` | Bilabial stop: the lips are shut. Mapping it to a vowel makes a "p" look like a shout |
| `FF` | `ih` | Lower lip to upper teeth — narrow, mostly closed |
| `TH` | `ih` | Tongue between the teeth, slightly open and wide |
| `DD` | `ih` | Tongue does the work behind a barely-open mouth |
| `kk` | `oh` | Made at the back with the jaw a little open |
| `CH` | `ou` | Lips push forward and round |
| `SS` | `ih` | Teeth close, lips drawn wide |
| `nn` | `sil` | Nasal: the mouth is closed |
| `RR` | `ou` | Approximant, lips rounded |
| `aa` `E` `I` `O` `U` | `aa` `ee` `ih` `oh` `ou` | Straight through |

Two things hold this in place. `satisfies Record<OculusViseme, Viseme>` means a sixteenth
viseme in a future release **fails the build** rather than falling through a default to
silence — a mouth that stops moving on certain sounds is exactly the bug that would ship
unnoticed. And `toVrmViseme` returns `sil` for anything unrecognised, because a closed
mouth is the safe wrong answer: it is what a face does between words.

Weight comes from `features.volume`, clamped — the library does not bound it — and
smoothed with a frame-rate-independent half-life so the same constant behaves the same at
30 fps and at 144. Every viseme is driven every frame, not just the winner, because a
shape left at its last weight is a mouth stuck in the previous sound.

## Results — 2026-09-09, Rick's machine

Chrome, Windows 11, NVIDIA GeForce RTX 5060 Ti, reported by WebGL as
`ANGLE (NVIDIA, NVIDIA GeForce RTX 5060 Ti (0x00002D04) Direct3D11 vs_5_0 ps_5_0, D3D11)`
and by WebGPU as `nvidia / blackwell`.

Two runs, 570 frames each after the warm-up, at 1× and at 2× the stage's CSS size. The
canvas figures are read from the drawing buffer rather than from what was asked for.

| | 1× | 2× |
|---|---|---|
| Canvas | **958×538** (0.52 Mpx) | **1916×1076** (2.06 Mpx) |
| **Median** | **120.5 fps** (8.3 ms) | **120.5 fps** (8.3 ms) |
| **5th percentile** | **117.6 fps** | **117.6 fps** |
| Worst frame | 8.8 ms | **15.0 ms** |
| Avatar load | 650 ms | 116 ms (cached) |
| VRMA clip | loaded | loaded |

1080p is 2.07 Mpx, so the 2× run is the budgeted resolution to within half a percent.

Lip sync: **passes.** Driven from the microphone and from a voice-only audio file. It
reads as speech rather than as chewing, which is the question the five-shape mapping had
to answer.

### What the frame times say, and what they do not

Read as frame *times* rather than as a frame rate, this is a stronger result than 120 fps
sounds — and a narrower one.

The median frame is 8.3 ms. A dropped frame at 120 Hz would be 16.6 ms, and across 570
frames at 1× there is **not one**; at 2× there is a single 15.0 ms frame, which is one
hitch in 570 and still under the two-period mark. That is why the 5th percentile is 117.6
fps in both runs rather than something ugly: there are almost no bad frames to find.

**But 8.3 ms is the display's period, not the scene's cost.** Vsync means the loop waited;
it does not mean the work took 8.3 ms. The GPU cost is somewhere below that, and neither
run can say how far below.

### Four times the pixels cost nothing measurable

This is the finding. `docs/PLAN.md` budgets **60 fps at 1080p**, and the first run was at
958×538 — a quarter of the pixels. Extrapolating a 540p pass into a 1080p pass is exactly
the claim this spike exists not to make, so the page grew a render-scale control and the
run was repeated at 2×.

**The median and the 5th percentile are identical.** 0.52 megapixels and 2.06 megapixels
produce the same 120.5 fps median and the same 117.6 fps 5th percentile. Quadrupling the
fill rate did not move either number, which says the scene is nowhere near fill-rate bound
— it is bound by the display, and the headroom underneath is large enough to absorb 4× the
pixels without showing.

The only thing that moved is the worst single frame, 8.8 ms → 15.0 ms. **Even that frame
fits inside a 60 fps budget of 16.67 ms.** So at the budgeted resolution, the worst frame
of the run still meets the target the plan sets, and every other frame is twice as fast as
it needs to be.

### The GPU-preference comparison could not be run, for a plainer reason than expected

The brief anticipated Chrome ignoring `powerPreference`, and it does on Windows:

```
The powerPreference option is currently ignored when calling requestAdapter()
on Windows. See https://crbug.com/369219127
```

But the machine settles it first: **there is no integrated GPU on that motherboard**, so
there is no second adapter to select. Rick's Linux box is the same hardware and the other
machines in the house are headless. A laptop is possible but not today.

Recorded as untested rather than as a result. It matters for the "browser-first on a
modest machine" claim in ADR-01, and it wants a genuinely different GPU class rather than
a second preference string on the same card.

### The idle clip loads and does nothing visible

The screenshot shows the character in its rest pose, arms out. `test.vrma` loaded and its
clip is playing; it has **three animation channels**, so there is nothing much for it to
animate. That is exactly what the file was expected to do — it proves the VRMA path and
says nothing about how an idle looks — and the screenshot is the confirmation rather than
a disappointment. A real idle clip is an asset decision for P2/P7.

### Also verified

- **The stack resolves and builds.** three 0.185.1, `@pixiv/three-vrm` 3.5.5,
  `@pixiv/three-vrm-animation` 3.5.5, `@react-three/fiber` 9.7.0 under React 19.2.8, and
  `wawa-lipsync` 0.0.2. `pnpm gate` green, 173 tests.
- **Nothing downloads before consent.** Zero requests to `githubusercontent` with the page
  open and the button untouched; both assets appear immediately after it.
- **The spike stays out of production.** `pnpm build` passes with the guard extended.

### Two defects found while driving it

Both mine, both fixed before the run:

- **The stage was not the size it claimed.** `max-width: 100%` inside a 900 px column
  clamped the 960 px stage to 800, so every frame rate would have been quoted against a
  size it was never measured at. The column now fits a real stage, and the page reports
  the canvas's **actual backing store** beside the size it asked for — which is how the
  958×538 above is known rather than assumed.
- **The GPU preference only existed on the consent screen**, so comparing settings meant
  reloading and re-downloading.

### A note on how the first attempt went wrong

The session before this one could not measure anything: the browser pane it had was
hidden, and a hidden page neither runs `requestAnimationFrame` nor delivers
`ResizeObserver` callbacks. That produced two symptoms that looked exactly like page bugs
— a canvas stuck at its intrinsic 300×150, and a frame window that never filled — and one
wrong diagnosis along the way (React StrictMode), which was tested and disproved rather
than worked around. Both were chased to the environment before anything reached this file.

## Outstanding

Nothing blocking. Whenever hardware allows: the same page on **a different class of GPU** —
a laptop, or anything with integrated graphics. This card is well above "mid-range", so
the interesting number is a worse machine, not this one. There is no integrated adapter on
that motherboard to select, and the Linux box is identical hardware.

## Go / no-go

**Go.** ADR-03 stands: a full-body VRM 1.0 with MToon materials, spring bones and node
constraints renders in a browser at a conversational frame rate **at 1080p**, and the lip
sync reads as speech.

1. **The budgeted resolution is met with the budget to spare.** 120.5 fps median at
   2.06 megapixels against a target of 60, and the worst frame of the whole run — 15.0 ms
   — still fits inside 60 fps's 16.67 ms. Quadrupling the pixels moved neither the median
   nor the 5th percentile.
2. **The integration risk is retired.** three-vrm with react-three-fiber under React 19 was
   the thing most likely to not work; it resolves, loads and builds. The r3f peer range is
   `>=19 <19.3`, so a React 19.3 bump needs attention when it comes.
3. **The five-shape mapping is enough.** Nine Oculus visemes with no VRM equivalent sounded
   like it would look wrong, and it does not. The table in `packages/avatar` is the thing
   to tune if it ever does, and it is one file with tests.
4. **The VRMA path exists**, unexercised. `test.vrma` proves the loader; a real idle clip
   is a P2/P7 asset decision.

### Left untested

- **The scene's real cost.** Vsync hid it in both runs. A GPU timer query or an unthrottled
  context would give the headroom as a number; the 4× pixel test bounds it well enough that
  nothing here needed one.
- **Any other GPU**, and any integrated adapter — none exists on that motherboard.
- **A second character.** The sample is a *constraint twist sample*, not a character — the
  right thing for measuring and the wrong thing for judging how the product looks. Do not
  let a screenshot of it become the reference for what Alice should be.
- **Memory.** Not recorded this run.
