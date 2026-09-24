# The affect engine

How the character feels, in `packages/core/src/affect` (P3-T01, ADR-12). This page is the
model; the numbers live in `DEFAULT_AFFECT_PARAMS` and move there, not here.

## What it holds

The protocol's `AffectState`, persisted per character:

| Part | Range | What it is | Moves on |
|---|---|---|---|
| `mood` — pleasure, arousal, dominance | −1…1 each | the slow state; what face, voice and wording agree on | tens of minutes |
| `events` | intensity 0…1 | fast feelings: an `[emote:x]` tag, the user's mood caught by empathy | seconds |
| `energy` | 0…1 | flat to lively: pace, gesture size, how much she offers | tens of minutes |
| `stance` — warmth, formality, engagement | −1…1 each | how she holds herself towards the user | about an hour |

## How it moves

Every `stepMs` (100 ms):

1. **Events fade.** Each halves every `halfLifeMs` (default 20 s, capped at 5 min) from when
   it began, and is dropped below `negligible` (0.02). Events are stored as they began, so
   aging one mutates nothing. At most `maxEvents` (16) are held; the weakest goes first.
2. **Everything relaxes towards the baseline** — mood with a 20 min half-life, energy 15 min,
   stance 45 min. With nothing happening, she comes back to herself.
3. **What she feels pushes.** Each live event pulls the mood towards its PAD point
   (`EMOTION_PAD`: joy pleasant and lively, sadness low, embarrassment submissive, pride
   dominant), energy by that point's arousal, and warmth and engagement by `EMOTION_STANCE`.
   A push moves a bounded fraction of the way to the edge of the range, so a mood can
   approach 1 but never pass it.

Formality moves only when told to (a `stance` input); nothing she feels makes her formal.

### The baseline

Slightly content, slightly awake, neither leading nor led (pleasure 0.2, arousal 0.05,
dominance 0); energy 0.6; warm, casual and attentive (0.4, −0.3, 0.3). A persona will set
its own; none does yet.

## Inputs

`AffectInput`, queued on an `AffectEngine` and applied in time order:

| Input | From | Becomes |
|---|---|---|
| `emotion` | `[emote:x]` tags (`affectInputsFrom`), later memory and schedules | an event, at `tagIntensity` (0.6) for a tag |
| `user-affect` | P3-T04/T05's fused estimate (`affect.user.updated`) | an event by empathy: happy → joy, sad/angry/fearful/disgusted → concern, surprised → surprise; intensity `empathy × confidence` |
| `stance` | the conversation (P3-T03/T09) | a clamped nudge |
| `energy` | the conversation, time of day (P6) | a clamped nudge |

An input lands on the **first step boundary at or after its own time**; one older than the
state is applied at the state's time rather than rewriting what already happened.

## Guarantees, and the tests that hold them

`packages/core/src/affect/engine.test.ts`, seeded random runs (mulberry32, so a failure
names its seed):

- **Bounded:** 300 random runs of up to 60 inputs — including out-of-range intensities,
  stance and energy nudges of ±5, half-lives of hours — always parse as `AffectStateSchema`,
  at the end and at every step. Mutation-checked: an unsaturated push fails it.
- **Decays to baseline:** a day after any of those runs, every event is gone and every
  dimension is within 0.01 of the baseline; and once nothing is felt, the distance to the
  baseline never grows. Mutation-checked: removing relaxation fails it.
- **Fixed timestep:** ticking every 16 ms and ticking once give the same state (events
  identical, mood to 1e-9).
- **Persistence:** JSON round-trips exactly; a saved mood outside its range is refused;
  restoring advances the gap — still upset a minute later, back to herself a week later.

## Cost

A gap is stepped only while an event is alive (at most ~28 minutes of 100 ms steps, from the
5-minute half-life cap), then jumped in closed form. The state is stepped as numbers and
converted to the stored form once.

## Voice and wording (P3-T03)

`packages/core/src/affect/express.ts`, pure like `affectToBody`:

- **`feltEmotion`** — the strongest live feeling above `eventFelt` (0.25), else the
  `EMOTION_PAD` point nearest the mood once the mood is past `moodFelt` (0.3; the baseline
  sits at ~0.21, so at rest she feels nothing in particular).
- **`affectToVoice(state, at, tags)`** → `VoiceStyle`: the TTS `hint` (a sentence's own
  `[emote:x]` names its feeling, so the voice never contradicts the face), a pace `rate`
  of 1 ± 15% and a `pauseMs` of 150–450 (250 at rest) after each sentence, both following
  *drive* — arousal and energy against the baseline. `Reply` takes it as `voiceStyle`, per
  sentence; `styledSpeed` keeps the result inside Kokoro's 0.75–1.25. The pace and pause
  are ours, so they work on Kokoro, which has no emotion control at all.
- **`describeFeeling`** — two lines for the system prompt (`PromptContext.affect`): how she
  feels in words ("unhappy, tired and slow … and right now sad"; "do not say it out loud"),
  and a length bias from `talkativeness` (energy, engagement, arousal): a sentence or two,
  as the moment needs, or say a bit more.

`pnpm live:affect` / `pnpm live:affect-voice` measure both (`docs/SURFACE.md`); R-19 is the ear.

## Not yet

- **Only `/dev/avatar` reads it.** P3-T02 maps it to a resting face, gaze habit, gesture bias
  and idle clip (`packages/avatar/src/affect`, R-18 passed); **`/chat` does not run it yet**
  (P3-T09). P3-T03 maps it to voice and wording (above), **built but not yet wired into `/chat`** — P3-T09 sets `PromptContext.affect` before each turn and passes `voiceStyle`. Until then the
  call's tag bridge (P2-T07) shows tags directly.
- **Nothing feeds it but tags and user affect.** The conversation's own events (being
  interrupted, a long silence, a warm reply) become `stance`/`energy`/`emotion` inputs in
  P3-T03/T09; time of day in P6.
- **Not persisted anywhere yet** — `serializeAffect`/`restoreAffect` are ready for P4's
  MariaDB row.
- **Every number is hand-set.** P3-T02's ten-state review (R-18, 2026-09-24) passed the body
  mapping on them; the engine's own dynamics (half-lives, gains) have not met a person yet —
  that is P3-T09's live call.
