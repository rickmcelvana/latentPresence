import { z } from 'zod';
import { AffectStateSchema, CharacterEmotionSchema, CharacterGestureSchema, UserAffectSchema } from './affect';
import { DurationMsSchema, IdSchema, JsonObjectSchema, JsonValueSchema, TimestampSchema, UnitIntervalSchema } from './common';
import { WordTimingSchema } from './media';

/** The states of the conversation machine (P1-T01). Exactly these, no sub-states. */
export const ConversationStateSchema = z.enum([
  'idle',
  'listening',
  'thinking',
  'speaking',
  'interrupted',
]);
export type ConversationState = z.infer<typeof ConversationStateSchema>;

/** Which inline tag this is. The grammar is `[emote:x]` / `[gesture:x]` (P1-T12). */
export const InlineTagKindSchema = z.enum(['emote', 'gesture']);
export type InlineTagKind = z.infer<typeof InlineTagKindSchema>;

/**
 * A tag the model wrote into its answer, lifted out of the spoken text by the sentence
 * chunker and carried on `assistant.sentence` (P1-T12, closing ADR-23).
 *
 * **`offset` indexes the spoken text, after the tag was removed** — the position in what
 * the user actually hears. That is the only offset P2-T07 can use, because it schedules
 * expressions and clips against TTS word timestamps, which are measured over speech and
 * know nothing about markup.
 *
 * **`value` is the raw label and `known` is the verdict on it.** A model invents labels;
 * dropping those silently would lose a gesture the avatar could still have approximated,
 * and passing them on as valid would ask P2 to map something it has no clip for. So the
 * raw label always survives and `known` is null when it is not on either list.
 */
export const InlineTagSchema = z.object({
  kind: InlineTagKindSchema,
  value: z.string().min(1),
  known: z.union([CharacterEmotionSchema, CharacterGestureSchema]).nullable(),
  offset: z.number().int().min(0),
});
export type InlineTag = z.infer<typeof InlineTagSchema>;

/**
 * Where the words are inside one sentence's audio, as played (P2-T07). Everything is in
 * ms from the sentence's first played frame — the moment `assistant.audio.started` stands
 * for — so a listener can place any character of the spoken text in time without the
 * audio itself.
 *
 * `voicedStartMs`/`voicedEndMs` bound the speech inside the segment's padding (ADR-27
 * keeps 50 ms before and 250 ms after). `words` is there only when the TTS reported word
 * timings — browser Kokoro does since P2-T09, a server may not; without them a position is
 * interpolated by character across the voiced span, the same estimate the spoken prefix uses.
 */
export const SentenceTimingSchema = z.object({
  durationMs: DurationMsSchema,
  voicedStartMs: DurationMsSchema,
  voicedEndMs: DurationMsSchema,
  words: z.array(WordTimingSchema).optional(),
});
export type SentenceTiming = z.infer<typeof SentenceTimingSchema>;

/** Who asked for a tool to run. Schedules and the user can, not only the model. */
export const ToolCallSourceSchema = z.enum(['llm', 'schedule', 'user']);
export type ToolCallSource = z.infer<typeof ToolCallSourceSchema>;

/** A request to run a tool, whether it lands on an MCP server or a local function. */
export const ToolCallSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  arguments: JsonObjectSchema,
  source: ToolCallSourceSchema,
  requestedAt: TimestampSchema,
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

/**
 * What came back. A failed tool is a normal outcome the character has to talk about,
 * so failure is a variant of the result rather than a thrown error.
 */
export const ToolResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    callId: IdSchema,
    value: JsonValueSchema,
    finishedAt: TimestampSchema,
  }),
  z.object({
    ok: z.literal(false),
    callId: IdSchema,
    error: z.string().min(1),
    finishedAt: TimestampSchema,
  }),
]);
export type ToolResult = z.infer<typeof ToolResultSchema>;

/** A line of transcript, either side, once it is settled. */
export const TranscriptEntrySchema = z.object({
  id: IdSchema,
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  at: TimestampSchema,
  /** For an assistant turn cut short: what the user actually heard before the fade. */
  spokenPrefix: z.string().nullable(),
});
export type TranscriptEntry = z.infer<typeof TranscriptEntrySchema>;

const eventBase = {
  sessionId: IdSchema,
  at: TimestampSchema,
};

/**
 * Everything that happens in a conversation, as one discriminated union. The state
 * machine, the transcript panel, the affect engine and the memory writer all read
 * this stream, so a new kind of happening is a new variant here and nowhere else.
 */
export const ConversationEventSchema = z.discriminatedUnion('type', [
  z.object({ ...eventBase, type: z.literal('session.started'), characterId: IdSchema }),
  z.object({ ...eventBase, type: z.literal('session.ended'), reason: z.enum(['user', 'idle', 'error']) }),

  z.object({ ...eventBase, type: z.literal('state.changed'), from: ConversationStateSchema, to: ConversationStateSchema }),

  z.object({ ...eventBase, type: z.literal('user.speech.started') }),
  z.object({ ...eventBase, type: z.literal('user.speech.ended') }),
  /**
   * The user's turn is over (P1-T07). `probability` is Smart Turn v3's answer when the model
   * ended it, and null when the hangover did and no answer was in time — a backstop end has
   * no probability, and a made-up one would read as the model's.
   *
   * A model end is **provisional** until the hangover would have fired (ADR-25): it may be
   * followed by `user.turn.resumed` for the same turn.
   */
  z.object({ ...eventBase, type: z.literal('user.turn.ended'), probability: UnitIntervalSchema.nullable() }),
  /**
   * A provisional turn end taken back: the user carried on talking inside the retraction
   * window, so the turn continues and the work started for it is abandoned (ADR-25, P1-T08).
   * `pauseMs` is how long they paused.
   */
  z.object({ ...eventBase, type: z.literal('user.turn.resumed'), pauseMs: DurationMsSchema }),
  z.object({
    ...eventBase,
    type: z.literal('user.transcript'),
    text: z.string(),
    isFinal: z.boolean(),
    confidence: UnitIntervalSchema.nullable(),
  }),
  z.object({ ...eventBase, type: z.literal('user.message'), text: z.string().min(1) }),

  /** Tag-free since P1-T12: `TagFilter` holds a partial tag back rather than streaming it. */
  z.object({ ...eventBase, type: z.literal('assistant.token'), text: z.string() }),
  /**
   * One chunk out of the sentence splitter, the unit TTS is asked for (P1-T04), with the
   * tags that were lifted out of it (P1-T12, closing ADR-23). `text` is what is spoken;
   * `tags` carry offsets into that spoken text, which is what P2-T07 schedules against.
   *
   * Additive: `tags` defaults to `[]`, so a producer written before P1-T12 still parses
   * and `PROTOCOL_VERSION` stays 1.
   */
  z.object({
    ...eventBase,
    type: z.literal('assistant.sentence'),
    text: z.string().min(1),
    index: z.number().int().min(0),
    tags: z.array(InlineTagSchema).default([]),
  }),
  /**
   * A sentence became audible. `timing` (P2-T07, additive, so `PROTOCOL_VERSION` stays 1)
   * is what the tag bridge schedules expressions and gestures against: the bus stamps
   * events when they are dispatched, which says nothing about a word 1.5 s into the audio.
   */
  z.object({
    ...eventBase,
    type: z.literal('assistant.audio.started'),
    sentenceIndex: z.number().int().min(0),
    timing: SentenceTimingSchema.optional(),
  }),
  z.object({ ...eventBase, type: z.literal('assistant.audio.ended'), sentenceIndex: z.number().int().min(0) }),
  z.object({ ...eventBase, type: z.literal('assistant.message'), entry: TranscriptEntrySchema }),
  /**
   * Barge-in. `spokenPrefix` is what the user heard before the fade, which is what the
   * transcript and memory must keep: the rest of the sentence was never said.
   */
  z.object({ ...eventBase, type: z.literal('assistant.interrupted'), spokenPrefix: z.string() }),
  /**
   * The character said a backchannel — "yeah", "right" — in a pause inside the user's turn
   * (P1-T09, ADR-28). Not part of any answer: it does not move the machine, it is not a
   * transcript line, and memory does not keep it. Emitted when the clip is queued, which on
   * an idle output is when it starts. It may be faded out early if the user speaks again.
   */
  z.object({ ...eventBase, type: z.literal('assistant.backchannel'), text: z.string().min(1) }),

  z.object({ ...eventBase, type: z.literal('tool.call'), call: ToolCallSchema }),
  z.object({ ...eventBase, type: z.literal('tool.result'), result: ToolResultSchema }),

  z.object({ ...eventBase, type: z.literal('affect.user.updated'), affect: UserAffectSchema }),
  z.object({ ...eventBase, type: z.literal('affect.character.updated'), state: AffectStateSchema }),

  z.object({
    ...eventBase,
    type: z.literal('error'),
    scope: z.enum(['stt', 'llm', 'tts', 'memory', 'tool', 'avatar', 'companion']),
    message: z.string().min(1),
  }),
]);
export type ConversationEvent = z.infer<typeof ConversationEventSchema>;

/** Every `type` the union carries, for exhaustiveness checks and for the tests. */
export const conversationEventTypes = ConversationEventSchema.options.map(
  (option) => option.shape.type.value,
);
