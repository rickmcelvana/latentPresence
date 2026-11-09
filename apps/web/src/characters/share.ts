import { PersonaSchema, type Persona } from '@latentpresence/protocol';
import { BROWSER_VOICE_GROUPS } from '../settings/VoiceSection';
import { newCharacterId, type StoredCharacter } from './character-shelf';
import { CLAIMS_HUMAN_WARNING, claimsHuman } from './edit';
import { ALICE, isBuiltInCharacter, type CharacterPack, type Characters } from './packs';

/**
 * A character as a file (P11-T05, ADR-74 item 9): `<name>.persona.json`, the persona alone (no
 * body, no memories, no settings). Read back, it is checked by the schema, each problem said in a
 * sentence, and shown before it is added, since every word of it goes to their model every turn.
 * Loaded only when Export or Import is used: Settings stays inside its budget (ADR-68).
 */

/** A persona is a few kB; anything past this is not one, and is not read further. */
export const CHARACTER_FILE_LIMIT = 64 * 1024;

/** An id kept from a file must look like one this app makes: it names a URL path and a memory namespace. */
const KEEPABLE_ID = /^u-[a-z0-9-]{1,100}$/u;

export function characterFileName(persona: Persona): string {
  const slug = persona.name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return `${slug || 'character'}.persona.json`;
}

/** The file's text: the persona as the schema has it, two-space JSON, as `personas/*.persona.json` are. */
export function characterFileText(persona: Persona): string {
  return `${JSON.stringify(PersonaSchema.parse(persona), null, 2)}\n`;
}

export function downloadCharacter(persona: Persona): void {
  const url = URL.createObjectURL(new Blob([characterFileText(persona)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = characterFileName(persona);
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * What happens to the file's id. `free`: one of theirs that nobody here has, kept (so memories
 * kept under it come back). `taken`: one of theirs already here, so replace it or add a new one.
 * `new-only`: Alice's, Theo's, or an id this app would not make, so it comes in under a new id.
 */
export type IdFate = 'free' | 'taken' | 'new-only';

export type ReadCharacter =
  | { readonly ok: false; readonly problems: readonly string[] }
  | {
      readonly ok: true;
      readonly persona: Persona;
      readonly fate: IdFate;
      /** The character already here under the file's id, for `taken` (and for Alice's or Theo's). */
      readonly here: CharacterPack | null;
      /** Said, never refused: a line telling them to claim to be human, a voice this app does not have. */
      readonly warnings: readonly string[];
    };

const FIELD: Readonly<Record<string, string>> = {
  version: 'the version',
  id: 'the id',
  name: 'the name',
  summary: 'who they are',
  style: 'how they talk',
  boundaries: 'what they will not do',
  voice: 'the voice',
  'voice.voiceId': 'the voice',
  'voice.speed': "the voice's speed",
  expressiveness: 'how often they gesture',
  'expressiveness.gestures': 'how often they gesture',
};

function fieldName(path: readonly PropertyKey[]): string {
  const [first, index] = path;
  if ((first === 'style' || first === 'boundaries') && typeof index === 'number') return `line ${index + 1} of ${FIELD[first]}`;
  return FIELD[path.map(String).join('.')] ?? path.map(String).join('.');
}

function capital(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

function at(value: unknown, path: readonly PropertyKey[]): unknown {
  let current = value;
  for (const part of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<PropertyKey, unknown>)[part];
  }
  return current;
}

/** One schema issue as a sentence naming the field the way the editor does. */
function issueSentence(issue: { readonly code: string; readonly path: readonly PropertyKey[]; readonly message: string; readonly maximum?: unknown; readonly minimum?: unknown; readonly origin?: unknown }, raw: unknown): string {
  const field = fieldName(issue.path);
  if (issue.path[0] === 'version') return 'It is not a version 1 character file, the only kind this app reads.';
  if (at(raw, issue.path) === undefined) return `${capital(field)} is missing.`;
  if (issue.code === 'too_big') {
    if (issue.origin === 'array') return `${capital(field)} has more than ${String(issue.maximum)} lines.`;
    return issue.origin === 'number' ? `${capital(field)} is above ${String(issue.maximum)}.` : `${capital(field)} is longer than ${String(issue.maximum)} characters.`;
  }
  if (issue.code === 'too_small') {
    if (issue.origin === 'array') return `${capital(field)} needs at least one line.`;
    return issue.origin === 'number' ? `${capital(field)} is below ${String(issue.minimum)}.` : `${capital(field)} is empty.`;
  }
  if (issue.code === 'invalid_value' && issue.path[0] === 'expressiveness') return 'How often they gesture must be rare, some or often.';
  return `${capital(field)} is not right: ${issue.message}.`;
}

const VOICES = new Set(BROWSER_VOICE_GROUPS.flatMap(({ voices }) => voices.map((voice) => voice.id)));

/** Reads a file's text against the characters here. Problems stop it; warnings are only said. */
export function readCharacterFile(text: string, list: Characters): ReadCharacter {
  if (text.length > CHARACTER_FILE_LIMIT) return { ok: false, problems: [`This file is larger than ${CHARACTER_FILE_LIMIT / 1024} kB; a character file is a few kB, so this is not one.`] };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, problems: ['This file is not JSON, so it is not a character file. One ends in .persona.json and was made by Export.'] };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, problems: ['This file holds no character: a character file is one JSON object with a name, who they are and how they talk.'] };
  const parsed = PersonaSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, problems: [...new Set(parsed.error.issues.map((issue) => issueSentence(issue, raw)))] };

  let persona = parsed.data;
  const warnings: string[] = [];
  const said = [persona.summary, ...persona.style, ...persona.boundaries].some((line) => claimsHuman(line));
  if (said) warnings.push(CLAIMS_HUMAN_WARNING);
  if (!VOICES.has(persona.voice.voiceId)) {
    warnings.push(`Its voice, ${persona.voice.voiceId}, is not one this app has, so they will speak with ${ALICE.persona.name}'s voice until you choose another.`);
    persona = { ...persona, voice: { ...persona.voice, voiceId: ALICE.persona.voice.voiceId } };
  }

  const here = list.packs.find((pack) => pack.persona.id === persona.id) ?? null;
  const fate: IdFate = isBuiltInCharacter(persona.id) || !KEEPABLE_ID.test(persona.id) ? 'new-only' : here === null ? 'free' : 'taken';
  return { ok: true, persona, fate, here, warnings };
}

/**
 * The stored character an import adds. `keep` the file's id (free), `replace` the one here under it
 * (its body and when it was made kept, its memories untouched), or `new`: a new id from the name, and
 * the name marked if someone here already has it.
 */
export function importedCharacter(
  read: Extract<ReadCharacter, { ok: true }>,
  choice: 'keep' | 'replace' | 'new',
  context: { readonly list: Characters; readonly existing: StoredCharacter | null; readonly now: Date; readonly makeId?: (name: string) => string },
): StoredCharacter {
  const stamp = context.now.toISOString();
  if (choice === 'new') {
    const named = context.list.packs.some((pack) => pack.persona.name === read.persona.name);
    const name = named ? `${read.persona.name} (imported)`.slice(0, 60) : read.persona.name;
    const id = (context.makeId ?? newCharacterId)(name);
    return { persona: { ...read.persona, id, name }, defaultBody: ALICE.defaultBody, createdAt: stamp, updatedAt: stamp };
  }
  const existing = choice === 'replace' ? context.existing : null;
  return { persona: read.persona, defaultBody: existing?.defaultBody ?? ALICE.defaultBody, createdAt: existing?.createdAt ?? stamp, updatedAt: stamp };
}
