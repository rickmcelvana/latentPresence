import { z } from 'zod';
import { IdSchema } from './common';

/**
 * Who the character is, as a file (P1-T12).
 *
 * A persona is **content, not code**: it lives in `personas/*.persona.json` at the repo
 * root so it can be read, edited and shared without touching a package, and it is parsed
 * rather than imported as a type, because the next reader of one is the companion (Rust
 * side, over the wire) and the one after that is P4's memory, which will write an edited
 * form back (`SelfModelBlock` in `memory.ts`).
 *
 * **Deliberately small.** Everything here is stable description — who she is, how she
 * talks, what she will not do. Nothing that changes during a conversation belongs in it:
 * mood is P3-T03, memories are P4, and the current time is `PromptContext` below. A
 * persona that carried state would have to be written back on every turn.
 */

/**
 * How freely the character uses `[gesture:x]`. Three levels rather than a number,
 * because the prompt has to say it in words and "0.6" is not a thing to say to a model.
 */
export const ExpressivenessSchema = z.object({
  gestures: z.enum(['rare', 'some', 'often']),
});
export type Expressiveness = z.infer<typeof ExpressivenessSchema>;

/**
 * The voice the persona asks for. A Kokoro voice id today; `/settings` may override it,
 * and a saved user choice always wins — the persona states a preference, not a lock.
 */
export const PersonaVoiceSchema = z.object({
  voiceId: z.string().min(1),
  /** Kokoro is only usable to ~1.25: past it the phonemes degrade (SURFACE, D-13). */
  speed: z.number().min(0.75).max(1.25),
});
export type PersonaVoice = z.infer<typeof PersonaVoiceSchema>;

/**
 * Short lines, not paragraphs. The whole persona is re-sent as a system prompt on every
 * turn, so length here is a per-turn cost; and the pilot (SURFACE) showed models follow
 * a terse imperative line far more reliably than a sentence of prose about a preference.
 */
const LineSchema = z.string().min(1).max(200);

export const PersonaSchema = z.object({
  /** Bumped when a field changes meaning. A file without it is not a persona. */
  version: z.literal(1),
  id: IdSchema,
  /** Shown in the transcript and spoken about in the first person. */
  name: z.string().min(1).max(60),
  /** One paragraph: who she is. Read by a person as much as by a model. */
  summary: z.string().min(1).max(1200),
  /** How she talks. */
  style: z.array(LineSchema).min(1).max(12),
  /** What she will not do or claim. Never empty: a character with no boundaries ships. */
  boundaries: z.array(LineSchema).min(1).max(12),
  voice: PersonaVoiceSchema,
  expressiveness: ExpressivenessSchema,
});
export type Persona = z.infer<typeof PersonaSchema>;

/**
 * What is true right now, passed beside the persona so `renderSystemPrompt` stays pure
 * and its output stays snapshot-testable. Everything optional is something a later phase
 * fills in: the user's name and mood (P3), retrieved memories (P4).
 */
export const PromptContextSchema = z.object({
  /** Written into the prompt as a plain readable line, so the model can answer "what day is it?". */
  now: z.date(),
  /** What the user likes to be called, when we know it. */
  userName: z.string().min(1).max(60).nullable().default(null),
});
export type PromptContext = z.infer<typeof PromptContextSchema>;
