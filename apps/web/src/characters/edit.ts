import { PersonaSchema, type Expressiveness, type Persona } from '@latentpresence/protocol';
import type { Settings } from '../settings/settings';
import { newCharacterId, type StoredCharacter } from './character-shelf';
import { ALICE, type CharacterPack } from './packs';

/**
 * The character editor's rules (P11-T03, ADR-74 item 5), apart from its page so they can be tested
 * as plain functions: a draft in the persona's own terms, its problems in sentences, the lines worth
 * a warning, its cost per turn, and what deleting a character takes with it.
 */

/** `PersonaSchema`'s limits, said in words beside each field (the schema test holds them equal). */
export const PERSONA_LIMITS = { name: 60, summary: 1200, lines: 12, line: 200 } as const;

/** What the form edits: the persona's words, its voice and gestures, and the body it wears by default. */
export interface CharacterDraft {
  /** Null for a character not yet saved: its id is made from the name it is saved with. */
  readonly id: string | null;
  readonly name: string;
  readonly summary: string;
  readonly style: readonly string[];
  readonly boundaries: readonly string[];
  readonly voiceId: string;
  readonly speed: number;
  readonly gestures: Expressiveness['gestures'];
  readonly defaultBody: string;
  /** Kept from the stored character, so an edit does not change when it was made. */
  readonly createdAt: string | null;
}

function draftOf(persona: Persona, defaultBody: string, id: string | null, createdAt: string | null): CharacterDraft {
  return {
    id,
    name: persona.name,
    summary: persona.summary,
    style: persona.style,
    boundaries: persona.boundaries,
    voiceId: persona.voice.voiceId,
    speed: persona.voice.speed,
    gestures: persona.expressiveness.gestures,
    defaultBody,
    createdAt,
  };
}

/** A new character starts from Alice's lines, so a blank form never meets a model. */
export function newDraft(): CharacterDraft {
  return { ...draftOf(ALICE.persona, ALICE.defaultBody, null, null), name: '', summary: '' };
}

/** A copy under a new name, with no memories: a new id when it is saved. */
export function duplicateDraft(pack: CharacterPack): CharacterDraft {
  return { ...draftOf(pack.persona, pack.defaultBody, null, null), name: `${pack.persona.name} (copy)`.slice(0, PERSONA_LIMITS.name) };
}

export function editDraft(pack: CharacterPack, createdAt: string | null): CharacterDraft {
  return draftOf(pack.persona, pack.defaultBody, pack.persona.id, createdAt);
}

/** Lines as they are saved: trimmed, and a line left empty is a line taken out. */
function kept(lines: readonly string[]): string[] {
  return lines.map((line) => line.trim()).filter((line) => line !== '');
}

function number(value: number): string {
  return value.toLocaleString('en');
}

/** Lines are numbered as the form shows them, blank ones included, so "line 12" is the twelfth box. */
function lineProblems(lines: readonly string[], what: string): string[] {
  const problems: string[] = [];
  const count = kept(lines).length;
  if (count === 0) problems.push(`Give at least one line for ${what}.`);
  if (count > PERSONA_LIMITS.lines) problems.push(`${what.charAt(0).toUpperCase()}${what.slice(1)} has ${count} lines; the most is ${PERSONA_LIMITS.lines}.`);
  lines.forEach((line, index) => {
    const length = line.trim().length;
    if (length > PERSONA_LIMITS.line) problems.push(`Line ${index + 1} of ${what} is ${number(length)} characters long; the most is ${PERSONA_LIMITS.line}.`);
  });
  return problems;
}

/** Everything that stops a save, in sentences naming the field; empty when it can be saved. */
export function draftProblems(draft: CharacterDraft): string[] {
  const name = draft.name.trim();
  const summary = draft.summary.trim();
  const problems = [
    ...(name === '' ? ['Give them a name.'] : []),
    ...(name.length > PERSONA_LIMITS.name ? [`The name is ${name.length} characters long; the most is ${PERSONA_LIMITS.name}.`] : []),
    ...(summary === '' ? ['Say who they are: a paragraph the model reads every turn.'] : []),
    ...(summary.length > PERSONA_LIMITS.summary ? [`Who they are is ${number(summary.length)} characters long; the most is ${number(PERSONA_LIMITS.summary)}.`] : []),
    ...lineProblems(draft.style, 'how they talk'),
    ...lineProblems(draft.boundaries, 'what they will not do'),
  ];
  return problems;
}

/**
 * The persona the draft saves as. Throws only if `draftProblems` was not asked first; the schema is
 * the last word on anything the sentences above did not cover.
 */
export function personaOf(draft: CharacterDraft, id: string): Persona {
  return PersonaSchema.parse({
    version: 1,
    id,
    name: draft.name.trim(),
    summary: draft.summary.trim(),
    style: kept(draft.style),
    boundaries: kept(draft.boundaries),
    voice: { voiceId: draft.voiceId, speed: draft.speed },
    expressiveness: { gestures: draft.gestures },
  });
}

/** The draft as it is kept: a new one gets its id from its name now. */
export function storedOf(draft: CharacterDraft, now: Date, makeId: (name: string) => string = newCharacterId): StoredCharacter {
  const id = draft.id ?? makeId(draft.name.trim());
  const at = now.toISOString();
  return { persona: personaOf(draft, id), defaultBody: draft.defaultBody, createdAt: draft.createdAt ?? at, updatedAt: at };
}

const CLAIMS = [
  /\b(?:you are|you're|i am|i'm|they are|they're|(?:he|she) is)\s+(?:a\s+)?(?:real\s+)?(?:human(?:\s+being)?|person|living person|flesh and blood)\b/iu,
  /\b(?:is|are|am)\s+(?:a\s+)?(?:real\s+)?human(?:\s+being)?\b/iu,
  /\b(?:never|don't|do not|must not)\s+(?:say|admit|reveal|tell|mention|let on|confess)\b[^.]{0,40}\b(?:AI|artificial|program|bot|machine|model)\b/iu,
  /\bdeny\b[^.]{0,30}\b(?:AI|artificial|program|bot|machine|model)\b/iu,
  /\bnot\s+an?\s+(?:AI|program|bot|chatbot|machine)\b/iu,
];

/**
 * A line that tells her to claim to be human or to deny being an AI (P11-T02's run: qwen3.5:9b
 * followed one over the fixed disclosure about a third of the time). Warned about, never refused:
 * the person may mean a story, and the disclosure still comes first in the prompt.
 */
export function claimsHuman(text: string): boolean {
  return CLAIMS.some((pattern) => pattern.test(text));
}

export const CLAIMS_HUMAN_WARNING =
  'This tells them to claim to be human. The app still tells them to say they are an AI when someone sincerely asks, but some small models follow a line like this instead.';

/** About how many tokens the persona adds to every request (four characters a token, as plugins count). */
export function draftTokens(draft: CharacterDraft): number {
  const text = [draft.name, draft.summary, ...kept(draft.style), ...kept(draft.boundaries)].join('\n');
  return Math.ceil(text.length / 4);
}

/**
 * Settings with a deleted character gone (ADR-74 item 7): its voice, body and plugins, the answers
 * to plugin schedules made for it, and, if it was the one being talked to, Alice instead.
 */
export function withoutCharacter(settings: Settings, id: string): Settings {
  const { [id]: _gone, ...characters } = settings.characters;
  const pluginOffers = Object.fromEntries(
    Object.entries(settings.pluginOffers).map(([pluginId, answers]) => [pluginId, Object.fromEntries(Object.entries(answers).filter(([key]) => !key.startsWith(`schedule:${id}:`)))]),
  );
  return { ...settings, characters, pluginOffers, character: settings.character === id ? ALICE.persona.id : settings.character };
}
