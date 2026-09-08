# @latentpresence/protocol

The shared vocabulary. Every other package compiles against this one; this one depends on nothing
but `zod`.

Nothing here does work — no I/O, no DOM, no audio, no timers, no Node built-ins. If a change to this
package needs a browser or a filesystem to make sense, it belongs somewhere else.

**Interfaces here change only in architect-owned tasks, with an ADR note** (`CLAUDE.md`).

## The zod / TypeScript line

**zod** for anything that crosses a boundary: rows in the database, HTTP and WS bodies, saved
settings, anything a model emits, anything read back from a file. Those values arrive from somewhere
we do not control — an older companion build, a model that invented a label, a database written by a
previous version — so they get parsed.

**Plain TypeScript** for values that live and die inside one process: PCM buffers, async iterables,
renderer handles, abort signals. Parsing forty thousand samples per audio chunk would cost more than
the pipeline it feeds, and no schema would have caught anything.

`media.ts` is the clearest example: `WordTiming` is a schema because it is written into the
transcript; `AudioChunk` is an interface because it goes from a worker to an AudioWorklet and stops.

Naming: a schema is `ThingSchema`, its inferred type is `Thing`.

## Modules

| Module | Holds |
|---|---|
| `common.ts` | Ids, ISO timestamps with a zone, `UnitInterval`, `SignedUnit`, `DurationMs`, recursive `JsonValue` |
| `media.ts` | `WordTiming` (schema), `AudioChunk` and `SpokenAudioChunk` (interfaces) |
| `affect.ts` | PAD `Mood`, the emotion vocabularies, `EmotionEvent`, `AffectState`, `UserAffect`, and the engine's outputs: `ExpressionWeights`, `GazeTarget`, `EmotionHint`, `AffectDirective` (ADR-12) |
| `conversation.ts` | `ConversationState`, `ToolCall`, `ToolResult`, `TranscriptEntry`, and `ConversationEvent` — the whole bus as one discriminated union |
| `schedule.ts` | `Schedule`, its trigger, delivery mode, catch-up policy and `ScheduleRun` (ADR-14) |
| `capabilities.ts` | One capability object per provider kind, `ModelDescriptor` for the consent screen, `ProviderDescriptor` for the settings UI |
| `memory.ts` | Episodes, bi-temporal `SemanticFact`, self-model blocks, plans, document hits, and the `MemoryStore` port (ADR-05) |
| `avatar.ts` | `Viseme`, `CharacterSource`, `ClipOptions` and the `AvatarRenderer` port (ADR-03) |
| `companion.ts` | The companion route table, its error envelope and its WS event union |
| `providers/` | `LLMProvider`, `STTProvider`, `TTSProvider`, `EmbeddingProvider`, `OmniProvider` with their request and result schemas |

Implementations live elsewhere: adapters in `packages/providers`, the renderer in `packages/avatar`,
the memory kernel in `packages/core`. Every provider ships a `Fake*` next to the real one, in that
package, never here.

## Shapes worth knowing before you use them

- **Timestamps carry a zone.** `2026-09-08T10:00:00` is rejected. The development database is in
  another country and the browser's clock is not the server's (ADR-17).
- **`MemoryStore.retrieve` is one call per turn.** Everything a turn needs comes back in one
  `RetrievalBundle`, with `elapsedMs` measured at the store so a WAN round trip can be told apart
  from a slow query.
- **Writes never block speaking.** `appendEpisode` and friends return promises the caller is free to
  drop; an adapter must not depend on being awaited.
- **`null` is a value, not an absence.** `contextLength: null` means the endpoint did not report one;
  `lastRunAt: null` means the schedule has never fired. Fields are required and nullable rather than
  optional, so a store that forgot to write one cannot look like a legitimate "not yet".
- **Emotion labels are closed sets.** Twelve for the character, because the LLM has to hit them in
  `[emote:x]` tags and P2-T01 maps each to a VRM preset. Nine for the user, matching what the prosody
  models emit.
- **Browser providers declare their downloads.** A `ProviderDescriptor` with a non-empty
  `requiresDownload` is one the consent screen must cover first — size, licence and source (ADR-09).

## Adding to it

1. Decide which side of the zod/TS line it falls on.
2. Put it in the module that already owns that subject; a new module needs a row in the table above.
3. Export it from `index.ts`.
4. Write the pair of tests: a sample that must parse, and a specific sample that must be rejected at
   a named path. State the invariant in a comment — what breaks if this schema were loosened.
5. Third-party shapes are verified against docs or a live call and recorded in `docs/SURFACE.md`
   with a date, never written from memory.
