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

## In the call (P3-T09)

`/chat` holds one engine for the page (`attachAffect`, core), fed from the bus like the
history — including a **typed answer shown as text**, which now puts its sentences on the bus
(`ChatSession`) so its tags are felt too. Three readers, each at the moment it needs it:

- **The prompt** — `ConversationHistory.system` is a function now, rendered on every request
  with `PromptContext.affect`; `now` stays fixed at mount, so only the last two lines move.
- **The voice** — `affect.voiceStyle` on `ChatVoice` (Speak replies) and on the call's `Reply`.
- **The body** — `CallStage` runs `affectToBody` every frame: the resting face max-merged under
  the tags' faces, and the gaze habit **relative to her baseline** (`relativeGaze`), because
  `affectToBody`'s identity is at energy 0.5 and engagement ≤ 0, not where Alice rests. At
  baseline the life layer gets `null` and the face `{}` — exactly `/chat` before P3-T09.

It starts at the baseline on every visit until P4 persists it. Gesture bias and idle-clip
choice are not used in the call yet: nothing performs gestures unprompted, and only `idle` exists.

## Reading the user from text (P3-T04)

`packages/core/src/affect/user-text.ts`, two readers producing `AffectReading`s for fusion:

- **`readUserText`** — what shows on the surface: emoji, emoticons, laughter, `?!`, runs of
  `!`, capitals, stretched words, a small lexicon of words that *name* a feeling (with
  negation), sarcasm frames, and message pace (`MessagePace`: a quick burst raises arousal).
  Instant, so a face can react before the model answers. It abstains on situations.
- **`readingFromTag`** — the model's `[user:x]`, first in its reply (ADR-32): it
  reads situations ("my dog died") that no surface rule can.

Held to 100 labelled messages (`docs/SURFACE.md`). **Nothing consumes the readings yet** —
P3-T07 fuses them into `UserAffect` and dispatches `affect.user.updated`, which the engine
already catches by empathy.

## Reading the user from their voice (P3-T05)

`SpeechEmotionReader` (`packages/providers/src/ser`) drives a gated worker
(`packages/ml-web/src/ser`) and returns an `AffectReading` on the `voice` channel for one
user speech segment. Default: the 9.7 MB emotion2vec+ distill on wasm (23–43 ms); option:
emotion2vec+ base on WebGPU, last 1.5 s (61–108 ms) — ADR-33. `other`/`unknown` probability
is the model not knowing: it lowers confidence, and below half the mass the reading is
neutral at zero confidence. Not in the call yet — P3-T07 fuses it.

## Reading the user's face (P3-T06)

Opt-in on `/chat` (**Read my face**), off on every visit. The first time, a card says what it
does and asks; agreeing turns the camera on and fetches the 3.8 MB landmarker; a light on the
user's picture shows while frames are read; turning it off turns off the camera it turned on.
MediaPipe Face Landmarker runs in a worker (`packages/ml-web/src/face`, ADR-34 on the pinned
version); `/chat` sends it ten frames a second as transferred `ImageBitmap`s, which the worker
closes once read, and nothing else keeps a pixel.

`FaceAffectReader` (`packages/core/src/affect/user-face.ts`) turns the 52 blendshapes into an
`AffectReading` on the `face` channel:

1. **Against the person's own resting face.** Each feature has a baseline that follows it
   down in ~1.5 s and up over a minute; only the rise above it counts. So low brows at rest
   are not anger, and a smile held for a minute is still a smile. It settles from the first
   frames it sees; confidence ramps up over the first 3 s.
2. **FACS patterns.** Happy: smile, with cheeks raised only alongside it. Sad: frown, the
   oblique brow (inner raised more than outer), and the chin raise (AU17) — because MediaPipe
   hardly reports the frown itself. Angry: brows down, lips pressed, sneer. Surprised: needs
   the brows; an open jaw alone is speech. Fear: wide eyes with raised inner brows, lip
   stretch. Disgust: sneer and upper lip. A smile holds back the negative ones.
3. **Smoothed** over ~0.5 s, and gone a second after the face is.

Confidence is capped at 0.7 and a neutral face is believed calm at up to 0.4 × that. **What it
can and cannot do**, from 42 generated faces (`docs/SURFACE.md`): happy and surprise
reliably; anger and sadness sometimes; **fear reads as surprise and disgust not at all**;
never a negative face as pleasant. So in fusion (P3-T07) it is good for arousal and for
"smiling or not", and valence beyond that should lean on text. Talking moves the mouth, so
readings while the user speaks deserve less weight — P3-T07 knows when that is. `/dev/face`
scores the set, times both delegates and reads a live camera for making faces at.

## Fusion: how the user seems, all at once (P3-T07)

`packages/core/src/affect/fusion.ts`. Each of four sources keeps **its latest reading**:
the text heuristic, the model's `[user:x]`, the voice and the face. At any moment each
weighs *channel × its own confidence × ½^(age / half-life)*:

| source | weight | half-life | why |
|---|---|---|---|
| `tag` (model) | 1.0 | 90 s | it reads situations no surface rule can (P3-T04: 84–90% right) |
| `text` | 0.8 | 90 s | surface cues are clear when present, and abstain otherwise |
| `face` | 0.6 | 4 s | live, but reliable only for smiling and arousal (P3-T06) |
| `voice` | 0.35 | 45 s | the default model mostly hears "neutral, a bit happy" (D-34) |

Three rules on top: the face counts **half while the user is speaking**; a voice `neutral`
below 0.5 is **no evidence** rather than calm (D-34); and once a new message arrives, the
model's read of the *previous* one counts a quarter — it was about something else.
Valence and arousal are the weighted mean; the label the weighted vote; confidence the
winner's share times the evidence in all (1 − Π(1 − wᵢ)). Nothing to go on is `null`.

**When it speaks up:** once per user turn — a typed `user.message`, or a spoken turn the
call hands over *before* `VoiceSession` builds its request, so the prompt sees it — and a
second time only if the model's `[user:x]` changes the label. That goes on the bus as
`affect.user.updated`, which the engine takes in by empathy (happy → joy, the negative ones →
concern). The prompt says it in one line (`describeUser`) at confidence ≥ 0.35: *"They seem
down (from what they wrote and how they sound). Let it shape how you answer; do not point it
out unless they do."*

**Replay.** Every input is recordable (`recordFusion`); `replayFusion` publishes exactly
what the live session did — no clock, no randomness. Two fixtures hold it: a scripted
session with every input kind, and one copied from `/chat?affect` against glm-5.2:cloud.
**`/chat?affect`** is the overlay: each source's reading and current weight, the fused
state, what she was last told, her mood, and **Copy recording**.

Seen live: before the model reads a message with no surface cue, the last read carries over
at 0.15–0.16 — too weak to be said, a small push to the engine — and the model's read then
corrects it. **The engine lags:** a joy felt in the first turn keeps lifting her pleasure for
~40 s, so in a quick exchange her mood trails the user's by a turn or two (P3-T01's
half-lives, which R-20 passed; P3-T08 may want the faster events rather than the mood).

## Not yet

- **Nothing feeds it but tags and user affect.** The conversation's own events (being
  interrupted, a long silence, a warm reply) should become `stance`/`energy`/`emotion` inputs;
  **no task owns that yet** (P3-T03/T09 did not). Time of day is P6.
- **Not persisted anywhere yet** — `serializeAffect`/`restoreAffect` are ready for P4's
  MariaDB row.
- **Every number is hand-set.** P3-T02's ten-state review (R-18, 2026-09-24) passed the body
  mapping on them; the engine's own dynamics (half-lives, gains) met a person in R-20
  (D-32, 2026-09-24): a sad run read as low and she came back over ten minutes at a pace that "seemed right".
