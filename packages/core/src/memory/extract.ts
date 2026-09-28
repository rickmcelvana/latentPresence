import { z } from 'zod';
import type { LlmMessage, SemanticFact } from '@latentpresence/protocol';
import type { ExtractedFact } from './facts';

/**
 * Reading durable facts out of an exchange (P4-T03, ADR-37): one model call after the
 * character has answered, off the speaking path. The model is shown the exchange and the
 * facts already believed, with their ids, and answers with JSON only — not a tool call,
 * because tool calling is the least uniform thing across the endpoints this project speaks
 * to (P1-T02/T03), while every one of them can write a JSON object when asked.
 *
 * The parser is tolerant of what models do around JSON (a code fence, a sentence before it)
 * and strict about what is inside: anything that does not fit the schema is dropped, fact
 * by fact, rather than failing the exchange.
 */

export interface Exchange {
  /** The user's words since the last extraction, in order. */
  readonly user: readonly string[];
  /** What the character said — for an interrupted answer, what the user heard. */
  readonly assistant: string;
  /** When the exchange happened, ISO-8601: "last month" is resolved against it. */
  readonly at: string;
}

export const EXTRACTION_SYSTEM = [
  'You maintain the long-term memory of a companion character about the person they talk to.',
  'Read one exchange and list the durable facts it states or clearly implies about the person and their world:',
  'who they are, where they live and work, people and pets in their life, plans with dates, lasting likes and dislikes, health, goals.',
  'Not: passing moods, small talk, questions, anything about the companion itself, or things the companion guessed.',
  '',
  'Answer with one JSON object and nothing else:',
  '{"facts":[{"subject":"user","predicate":"lives_in","object":"Halifax","confidence":0.9,"validFrom":null,"replaces":null}],"ended":[]}',
  '',
  'Rules:',
  '- subject is "user" for the person; for someone else, their name or role in snake_case ("sister", "dog_biscuit").',
  '- predicate is short snake_case: name, age, birthday, lives_in, hometown, works_at, job, studies_at, partner, has_pet, has_sibling, likes, dislikes, allergic_to, goal, plans_to, favorite_food, …',
  '- object is the value in plain words, as short as it can be and still be clear.',
  '- confidence: 0.9 when stated plainly, 0.6 when implied, 0.4 when hedged ("I think", "maybe").',
  '- validFrom: when it became true, as an ISO date, only if the exchange says ("since March", "last month" — resolve against the exchange date); else null.',
  '- replaces: the id of a known fact this new one makes untrue ("I moved", "I changed jobs"); else null.',
  '- ended: ids of known facts the exchange says are no longer true with nothing new in their place ("the trip is off", "we broke up", "I quit running").',
  '- List only what this exchange says. Do not repeat known facts the person did not mention again.',
  '- Nothing to record: {"facts":[],"ended":[]}.',
].join('\n');

function knownLines(known: readonly SemanticFact[]): string {
  if (known.length === 0) return 'Known facts: none yet.';
  return ['Known facts (id: subject predicate object):', ...known.map((fact) => `${fact.id}: ${fact.subject} ${fact.predicate} ${fact.object}`)].join('\n');
}

export function extractionMessages(exchange: Exchange, known: readonly SemanticFact[]): LlmMessage[] {
  const user = exchange.user.map((line) => `Person: ${line}`).join('\n');
  return [
    { role: 'system', content: EXTRACTION_SYSTEM },
    {
      role: 'user',
      content: [`Exchange date: ${exchange.at.slice(0, 10)}`, knownLines(known), '', 'Exchange:', user, `Companion: ${exchange.assistant}`].join('\n'),
    },
  ];
}

const ExtractedFactSchema = z.object({
  subject: z.string().min(1),
  predicate: z.string().min(1),
  object: z.union([z.string(), z.number(), z.boolean()]).transform(String),
  confidence: z.number().min(0).max(1).catch(0.6),
  validFrom: z.string().nullish().catch(null),
  replaces: z.string().nullish().catch(null),
});

/** An ISO date or datetime the model gave, normalised; anything else is null. */
function normaliseDate(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}(-\d{2})?(T.*)?$/.test(trimmed)) return null;
  const parsed = new Date(/^\d{4}-\d{2}$/.test(trimmed) ? `${trimmed}-01` : trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** The first balanced JSON object in `text`, skipping fences and prose around it. */
function firstObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (char === '\\') i += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export interface ParsedExtraction {
  readonly facts: ExtractedFact[];
  /** Ids of known facts the exchange ended with nothing in their place. */
  readonly ended: string[];
  /** Entries dropped for not fitting the schema, or null when there was no JSON at all. */
  readonly dropped: number | null;
}

export function parseExtraction(text: string): ParsedExtraction {
  const json = firstObject(text);
  if (json === null) return { facts: [], ended: [], dropped: null };
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return { facts: [], ended: [], dropped: null };
  }
  const list = (value as { facts?: unknown }).facts;
  const endedList = (value as { ended?: unknown }).ended;
  const ended = Array.isArray(endedList) ? endedList.filter((id): id is string => typeof id === 'string' && id !== '') : [];
  if (!Array.isArray(list)) return { facts: [], ended, dropped: null };
  const facts: ExtractedFact[] = [];
  let dropped = 0;
  for (const entry of list) {
    const parsed = ExtractedFactSchema.safeParse(entry);
    if (!parsed.success || parsed.data.object.trim() === '') {
      dropped += 1;
      continue;
    }
    facts.push({
      subject: parsed.data.subject,
      predicate: parsed.data.predicate,
      object: parsed.data.object,
      confidence: parsed.data.confidence,
      validFrom: normaliseDate(parsed.data.validFrom),
      replaces: parsed.data.replaces ?? null,
    });
  }
  return { facts, ended, dropped };
}
