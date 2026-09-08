import { z } from 'zod';
import { AffectStateSchema, UserAffectSchema } from './affect';
import { IdSchema, JsonObjectSchema, JsonValueSchema, TimestampSchema, UnitIntervalSchema } from './common';

/** The states of the conversation machine (P1-T01). Exactly these, no sub-states. */
export const ConversationStateSchema = z.enum([
  'idle',
  'listening',
  'thinking',
  'speaking',
  'interrupted',
]);
export type ConversationState = z.infer<typeof ConversationStateSchema>;

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
  /** Turn-end probability from Smart Turn v3, or the adaptive-silence fallback (P1-T07). */
  z.object({ ...eventBase, type: z.literal('user.turn.ended'), probability: UnitIntervalSchema }),
  z.object({
    ...eventBase,
    type: z.literal('user.transcript'),
    text: z.string(),
    isFinal: z.boolean(),
    confidence: UnitIntervalSchema.nullable(),
  }),
  z.object({ ...eventBase, type: z.literal('user.message'), text: z.string().min(1) }),

  z.object({ ...eventBase, type: z.literal('assistant.token'), text: z.string() }),
  /** One chunk out of the sentence splitter, the unit TTS is asked for (P1-T04). */
  z.object({ ...eventBase, type: z.literal('assistant.sentence'), text: z.string().min(1), index: z.number().int().min(0) }),
  z.object({ ...eventBase, type: z.literal('assistant.audio.started'), sentenceIndex: z.number().int().min(0) }),
  z.object({ ...eventBase, type: z.literal('assistant.audio.ended'), sentenceIndex: z.number().int().min(0) }),
  z.object({ ...eventBase, type: z.literal('assistant.message'), entry: TranscriptEntrySchema }),
  /**
   * Barge-in. `spokenPrefix` is what the user heard before the fade, which is what the
   * transcript and memory must keep: the rest of the sentence was never said.
   */
  z.object({ ...eventBase, type: z.literal('assistant.interrupted'), spokenPrefix: z.string() }),

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
