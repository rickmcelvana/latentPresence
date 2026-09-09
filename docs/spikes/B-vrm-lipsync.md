# Spike B — VRM avatar and lip sync

**Status: harness built and wired; the frame-rate run is outstanding and needs Rick.**
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

## Verified here, 2026-09-09

- **The stack resolves and builds.** three 0.185.1, `@pixiv/three-vrm` 3.5.5,
  `@pixiv/three-vrm-animation` 3.5.5, `@react-three/fiber` 9.7.0 under React 19.2.8, and
  `wawa-lipsync` 0.0.2. `pnpm gate` green, 173 tests.
- **The avatar and the clip load.** `VRM1_Constraint_Twist_Sample.vrm` through
  `GLTFLoader` + `VRMLoaderPlugin` in **230–730 ms warm**, and `test.vrma` parses into a
  `VRMAnimation` through `VRMAnimationLoaderPlugin`. The VRMA path exists.
- **Nothing downloads before consent.** Zero requests to `githubusercontent` with the page
  open and the button untouched; both assets appear immediately after it.
- **The spike stays out of production.** `pnpm build` passes with the guard extended.
- **The WebGL adapter is reachable**: `ANGLE (NVIDIA, NVIDIA GeForce RTX 5060 Ti
  (0x00002D04) Direct3D11 vs_5_0 ps_5_0, D3D11)`.

### `powerPreference` is ignored on Windows

Chrome logs it plainly:

```
The powerPreference option is currently ignored when calling requestAdapter()
on Windows. See https://crbug.com/369219127
```

So the integrated-versus-discrete comparison the brief asked for **cannot be made this way
on Windows**. The control is still there and the WebGL context takes its own hint, but if
both settings report the same adapter, the write-up gets one number and a sentence saying
why — not the discrete figure printed under two headings.

### Two defects found while driving it

Both mine, both fixed:

- **The stage was not the size it claimed.** `max-width: 100%` inside a 900 px column
  clamped the 960 px stage to 800, so every frame rate would have been quoted against a
  size it was never measured at. The column now fits a real stage, and the page reports
  the canvas's **actual backing store** beside the size it asked for, so a future clamp is
  visible rather than assumed.
- **The GPU preference only existed on the consent screen**, so comparing the two settings
  meant reloading and re-downloading. It is on the running panel now, and switching it
  remounts the canvas and resets the frame window.

## Not verified here — and why

**No frame rate, and no confirmation that anything is actually drawn.** The browser pane
available to this session is hidden, and a hidden page does not render: `requestAnimationFrame`
never fires and `ResizeObserver` never delivers its callbacks. That produced two symptoms
that looked like page bugs and were not — a canvas stuck at its intrinsic 300×150, and a
frame window that never filled — and both were chased to the environment before anything
was written down here.

This is the right outcome anyway. A frame rate measured inside an embedded, throttled pane
at whatever size it happened to be would be worse evidence than one from a real browser
window at a stated size. Spikes A and D were both run on the machine for the same reason.

## Outstanding — the run

`pnpm dev`, then <http://localhost:5173/spike/avatar>, in a normal Chrome window.

1. Accept the consent screen. Confirm the avatar appears and is framed head-and-shoulders.
2. Let it settle for a few seconds, then **Take the reading**. Record median fps, 5th
   percentile, worst frame, and the canvas size the page reports.
3. Switch **GPU preference** to low-power and take a second reading. If the adapter string
   does not change, say so — that is the Windows limitation above, not a result.
4. **Drive the mouth from the microphone** and watch the lips against the mapping table.
   The question is not whether it is accurate — it cannot be, with five shapes — but
   whether it reads as speech or as chewing. If consonants look wrong, the table above is
   the thing to change, and it is one file with tests.
5. Screenshot, for the write-up.

## Go / no-go

**Not yet decided.** What can be said:

- **The stack works together.** three-vrm and react-three-fiber under React 19 was the
  integration risk, and it resolves, loads and builds. The r3f peer range is `>=19 <19.3`,
  so a React 19.3 bump will need attention.
- **The VRMA path exists**, though `test.vrma` has three animation channels and proves the
  loader rather than anything about how an idle looks. A real idle clip is an asset
  decision for P2/P7; there is no CC0 VRMA in that repository to take.
- **Whether ADR-03 stands is unanswered**, and needs a frame rate from a real window.

### Left untested

- Frame rate, anywhere, on any adapter.
- Whether the lip sync reads as speech.
- Integrated graphics, which Windows may not let us select at all.
- A second character. The sample is a *constraint twist sample*, not a character — the
  right thing for measuring and the wrong thing for judging how the product looks. Do not
  let a screenshot of it become the reference for what Alice should be.
