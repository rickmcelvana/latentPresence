# Transcript panel and text chat — design notes (P1-T11)

Written 2026-09-14 by the architect, before the task, as the plan asks. P1-T11 is done when
the panel matches this note. Where this note and the code disagree later, fix the note
first or say why not.

## What it is for

A record of what was **said** in a conversation, spoken or typed, that a person can read
while it happens and copy afterwards. Three rules follow from "said", and every other rule
comes from them:

1. **Only what reached the user.** An answer cut off by a barge-in shows the words that were
   heard; the rest is marked as never said (ADR-26). A reply abandoned before anyone heard it
   is not a line at all.
2. **Nothing appears that is later taken back.** A turn the model ended provisionally is not
   on the bus until it is confirmed (ADR-25; `VoiceSession` holds the transcript, tokens and
   sentences since P1-T11), so the panel never shows a user line and then removes it.
3. **Not everything the character makes a sound for is speech.** A backchannel ("Yeah.") is
   not a line (ADR-28), and neither is the model's reasoning.

## Where it appears

- **`/chat`** — a production page: the transcript plus a text box, talking to the language
  model configured in `/settings`. No voice yet: a browser voice needs download consent
  (P1-T13). Without a configured endpoint and model, the page says so and links to
  `/settings` instead of showing a box that cannot work.
- **`/dev/voice`** — the voice harness gains the panel beside its measurement tables, so a
  spoken conversation, its interruptions and its latencies can be read as a person would.
- **Phase 2** mounts the same component beside the stage in the call screen. Build it as a
  component that takes a stream of events, not a page that owns a session.

## The source of truth: the bus, through one pure reducer

The panel reads `ConversationEvent`s and nothing else. The rules below live in a pure
function in `packages/core/src/transcript/` — `reduceTranscript(state, event)` — with no DOM,
so they are tested as a table and Phase 2 and memory can reuse them. The component renders
`state.lines`.

```ts
type TranscriptLine =
  | { kind: 'user'; id: string; text: string; at: string; via: 'voice' | 'text' }
  | {
      kind: 'assistant';
      id: string;
      at: string;
      status: 'streaming' | 'complete' | 'interrupted';
      /** Streaming: the raw tokens so far. Settled: the entry's tag-free text. */
      text: string;
      /** Interrupted: what was heard (the entry's `spokenPrefix`). Otherwise null. */
      heard: string | null;
      /** Interrupted: the part of `text` after `heard` — generated, never said. May be ''. */
      unsaid: string;
      firstTokenMs: number | null;
      firstAudioMs: number | null;
    }
  | { kind: 'notice'; id: string; at: string; text: string };
```

### Event rules

| Event | Effect |
|---|---|
| `user.turn.ended` | Remember its `at` as the start of the turn (for latency). No line. |
| `user.turn.resumed` | Forget that start: the turn continues and will end again. No line. |
| `user.transcript` with `isFinal: true` | A `user` line, `via: 'voice'`. Non-final transcripts are ignored (no browser recogniser produces partials). |
| `user.message` | A `user` line, `via: 'text'`; its `at` is the start of the turn. |
| `assistant.token` | Append to the streaming `assistant` line, creating it if there is none. The first token sets `firstTokenMs` = token `at` − turn start. |
| `assistant.audio.started` | On the current assistant line (streaming, or the last one not yet settled), set `firstAudioMs` once, the same way. |
| `assistant.interrupted` | Mark the current assistant line `interrupted`; the settling message follows. |
| `assistant.message` | Settle the current assistant line with `entry`: `id`, `text`, `at`. `spokenPrefix` null → `complete`; otherwise `interrupted`, `heard` = `spokenPrefix`, `unsaid` = the rest of `text` when `text` starts with it, else ''. **An entry with empty `text` removes the line** (a stopped reply that never showed a word). With no current line (an answer that never streamed a token), create one settled. |
| `state.changed` to `listening` or `idle` | A line still `streaming` — never settled, never interrupted — is dropped: the reply was abandoned before anyone heard it. (The machine emits `assistant.message` *before* its own `state.changed`, so a settled line is already final.) |
| `error` | A `notice` line: "The language model failed: …", "The voice failed: …", and so on by `scope`. **Except** `scope: 'stt'` with `nothing was recognised`, which is noise, not news. |
| `assistant.backchannel` | Nothing. Never a line (ADR-28). |
| everything else | Nothing: sentences, audio ends, speech start/end, tool and affect traffic, session start/end. |

Turn start for latency: the last `user.turn.ended` not cancelled by `user.turn.resumed`, or
the last `user.message`. A token or audio start with no turn start leaves its figure null.

**Timestamps are the events' `at`.** `VoiceSession` stamps held events with when they
happened, not when the turn was confirmed, so first-token latency measures the model, and
first-audio latency measures what the user waited — including the confirmation hold, which
is real waiting.

## How it looks

Styled in `theme.css` with the tokens, like everything else.

- **Lines** read as a conversation, oldest at the top: the user's on one side, the
  character's on the other, each with a name ("You", the character's name — "Alice" until
  personas exist) and a time (`HH:MM`).
- **Streaming**: the assistant line grows as tokens arrive, with a quiet cursor at its end.
  Until P1-T12 lifts inline tags out of the stream, a tag like `[emote:smile]` can show
  briefly while streaming; the settled line never has one.
- **Interrupted**: the heard text is normal; the unsaid remainder follows it, muted and
  struck through, with a small **interrupted** pill after the line. Screen readers get
  "(not said)" before the unsaid part, not a strike-through they cannot see.
- **Latency badges** under a settled assistant line: `first word 412 ms` and `first audio
  893 ms`; ≥ 1000 ms as `1.2 s`. Only the figures that exist — a typed chat has no audio. A
  `title` says what each measures: "From the end of your turn to the first word of the
  answer" / "… to the first sound of it".
- **Notices** are one muted line with the danger colour on a small marker, not a bubble.
- **Scrolling**: new content keeps the view at the bottom **only if it already was**. A reader
  who scrolled up is not pulled down; a **Jump to latest** button appears instead.
- **Accessibility**: the line list is a `log` region (`role="log"`, polite). Tokens do not
  announce one by one — a line is announced when it settles.

## Copy and clear

- **Copy transcript** writes plain text to the clipboard, one line per entry:
  `You: what time is it` / `Alice: It is nearly three.` An interrupted line copies what was
  heard followed by ` [interrupted]`; the unsaid part is not copied. A notice copies as
  `[error] The language model failed: …`. A streaming line copies what has arrived so far.
  Badges are not copied. Confirm with a short "Copied" status; say so if the clipboard
  refuses.
- **"One line per entry" is one *entry* per line, not one physical line** (R-6, 2026-09-21).
  Entries are joined with `
` and each answer's text is copied verbatim, so a model that
  writes markdown keeps its own newlines, headings and bullets — Rick's `/chat` paste has
  four-line and eight-line answers. That is what was on screen, and it is the right trade:
  reflowing an answer to one line would misquote it. The consequence is that a pasted
  transcript cannot be split back into entries by line, so **nothing should parse it** —
  anything that needs the structure reads `TranscriptLine[]`, not the clipboard text.
- **Clear** empties the panel's lines. It does not stop an answer, end the session or touch
  the model's history — this is the panel's view, not the conversation (memory is P4). No
  confirmation dialog: nothing is lost that matters yet.

## The text box (`/chat`)

- A multi-line field. **Enter sends; Shift+Enter is a new line.** Blank sends nothing.
- While an answer streams, a **Stop** button stops it (`ChatSession.stop`). Sending while
  one streams stops that one first — `ChatSession.send` already does.
- Focus stays in the field after sending.
- The page builds the provider exactly as `/settings` tests it: the saved endpoint, base
  URL, model and temperature, the key from the vault, and the companion relay for a `relay`
  endpoint. If the companion is needed and not running, the failure is a notice line with the
  same words `/settings` uses.

## Not in this task

Persisting the transcript across reloads (memory, P4); editing or deleting a line; partial
user transcripts; tool-call lines (P5); a persona's name and system prompt (P1-T12); voice on
`/chat` (after P1-T13's consent); typed messages during a spoken call (Phase 2's call screen).
