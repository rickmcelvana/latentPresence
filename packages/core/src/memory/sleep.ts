import type { LlmMessage, SemanticFact } from '@latentpresence/protocol';
import { FOLLOW_UP_PREDICATE } from '../plan/plans';
import { reinforce } from './facts';

/**
 * Sleep's merging (P6-T04, ADR-53): what was said twice in other words becomes one fact.
 *
 * P4-T03's pass (`consolidate.ts`) merges only facts that are word for word the same. People say
 * the same thing differently — "likes jazz", "loves jazz", "favourite_music jazz music" — and
 * extraction, shown the known facts, still writes some of those as new. Two steps, in order:
 *
 * 1. **By rule**: the same subject, a predicate from the same family (likes, loves, enjoys…), and
 *    the same object once case, punctuation and leading articles are gone. Free, and certain.
 * 2. **By the model**, per subject, with reasoning off as extraction is (ADR-37): which of these
 *    say the same thing, and which wording to keep. Only ids it was shown are taken, only groups
 *    within one subject, and never a follow-up (a plan's, ADR-41).
 *
 * A merge keeps one fact, reinforced by the others' confidence and true from the earliest of
 * their starts, and expires the rest: what they said lives on in the one kept.
 */

/** Predicates that mean the same, by the first in each family. */
const PREDICATE_FAMILIES: readonly (readonly string[])[] = [
  ['likes', 'loves', 'enjoys', 'is_into', 'into', 'fan_of', 'is_fan_of', 'fond_of', 'is_fond_of', 'likes_to'],
  ['dislikes', 'hates', 'does_not_like', 'doesnt_like', 'cant_stand', 'can_not_stand'],
  ['works_at', 'employer', 'works_for', 'employed_at', 'employed_by'],
  ['job', 'occupation', 'profession', 'works_as', 'job_title', 'role'],
  ['has_pet', 'pet', 'owns_pet', 'has_dog', 'has_cat'],
  ['lives_in', 'resides_in', 'lives_at', 'location', 'home'],
  ['hometown', 'grew_up_in', 'from', 'is_from', 'born_in'],
  ['allergic_to', 'allergy', 'has_allergy', 'allergies'],
  ['goal', 'wants_to', 'aims_to', 'hopes_to'],
];

const FAMILY = new Map<string, string>(PREDICATE_FAMILIES.flatMap((members) => members.map((predicate) => [predicate, members[0] ?? predicate] as const)));

function family(predicate: string): string {
  return FAMILY.get(predicate) ?? predicate;
}

/** "The Jazz." → "jazz"; "a beagle called Biscuit" stays itself, lower case. */
export function plainObject(object: string): string {
  return object
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replaceAll(/\b(the|a|an|my|our|his|her|their)\b/gu, ' ')
    .replaceAll(/\s+/gu, ' ')
    .trim();
}

export function mergeKey(fact: SemanticFact): string {
  return [fact.characterId, fact.subject.toLowerCase(), family(fact.predicate.toLowerCase()), plainObject(fact.object)].join('\u0000');
}

function mergeable(fact: SemanticFact): boolean {
  return fact.predicate !== FOLLOW_UP_PREDICATE;
}

export interface MergeGroup {
  /** The fact kept: its wording stays. */
  readonly keep: string;
  /** The facts folded into it, expired. */
  readonly merge: readonly string[];
}

/** Step 1: groups by rule. The kept one is the earliest recorded. */
export function ruleMerges(facts: readonly SemanticFact[]): MergeGroup[] {
  const groups = new Map<string, SemanticFact[]>();
  for (const fact of facts.filter(mergeable)) groups.set(mergeKey(fact), [...(groups.get(mergeKey(fact)) ?? []), fact]);
  return [...groups.values()]
    .filter((group) => group.length > 1)
    .map((group) => {
      const [kept, ...rest] = group.toSorted((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.id.localeCompare(b.id));
      return { keep: kept?.id ?? '', merge: rest.map((fact) => fact.id) };
    });
}

/** The phrase `pnpm live:sleep` tells a merge request from an extraction by. */
export const MERGE_MARKER = 'say the same thing';

export const MERGE_SYSTEM = [
  'You tidy the long-term memory of a companion character. Below are facts it believes about one subject.',
  `Find facts that ${MERGE_MARKER} in different words: the same piece of information, so keeping one loses nothing.`,
  'For each such group, keep the one worded most clearly and merge the others into it.',
  '',
  'Same thing: "likes jazz" and "loves jazz music"; "job software developer" and "works_as programmer"; "has_pet beagle named Biscuit" and "has_dog Biscuit".',
  'Not the same: "likes jazz" and "likes Coltrane" (one adds a detail); "lives_in Halifax" and "hometown Moncton"; facts with different dates or numbers.',
  '',
  'Answer with one JSON object and nothing else:',
  '{"groups":[{"keep":"f3","merge":["f9","f12"]}]}',
  'Use only the ids listed. Nothing to merge: {"groups":[]}.',
].join('\n');

export function mergeMessages(subject: string, facts: readonly SemanticFact[]): LlmMessage[] {
  return [
    { role: 'system', content: MERGE_SYSTEM },
    { role: 'user', content: [`Subject: ${subject}`, 'Facts (id: predicate object):', ...facts.map((fact) => `${fact.id}: ${fact.predicate} ${fact.object}`)].join('\n') },
  ];
}

/** The model's groups, kept only where every id is one it was shown and none is used twice. */
export function parseMerges(text: string, shown: ReadonlySet<string>): MergeGroup[] {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  let value: unknown;
  try {
    value = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  const raw = (value as { groups?: unknown }).groups;
  if (!Array.isArray(raw)) return [];
  const used = new Set<string>();
  const groups: MergeGroup[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { keep, merge } = entry as { keep?: unknown; merge?: unknown };
    if (typeof keep !== 'string' || !Array.isArray(merge)) continue;
    const ids = merge.filter((id): id is string => typeof id === 'string' && id !== keep);
    if (!shown.has(keep) || ids.length === 0 || ids.some((id) => !shown.has(id)) || [keep, ...ids].some((id) => used.has(id))) continue;
    for (const id of [keep, ...ids]) used.add(id);
    groups.push({ keep, merge: [...new Set(ids)] });
  }
  return groups;
}

/** The subjects worth asking about — two or more mergeable facts — in batches the model can read. */
export function mergeBatches(facts: readonly SemanticFact[], perBatch = 40): { readonly subject: string; readonly facts: SemanticFact[] }[] {
  const bySubject = new Map<string, SemanticFact[]>();
  for (const fact of facts.filter(mergeable)) bySubject.set(fact.subject, [...(bySubject.get(fact.subject) ?? []), fact]);
  return [...bySubject.entries()]
    .filter(([, group]) => group.length > 1)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .flatMap(([subject, group]) => {
      const sorted = group.toSorted((a, b) => a.predicate.localeCompare(b.predicate) || a.id.localeCompare(b.id));
      const batches: { subject: string; facts: SemanticFact[] }[] = [];
      for (let i = 0; i < sorted.length; i += perBatch) batches.push({ subject, facts: sorted.slice(i, i + perBatch) });
      return batches;
    });
}

/** What a set of merges writes: the kept facts reinforced and widened, the rest expired. */
export function applyMerges(facts: readonly SemanticFact[], groups: readonly MergeGroup[], now: Date): { upserts: SemanticFact[]; expire: { id: string; at: string }[] } {
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  const at = now.toISOString();
  const upserts: SemanticFact[] = [];
  const expire: { id: string; at: string }[] = [];
  for (const group of groups) {
    const kept = byId.get(group.keep);
    const merged = group.merge.flatMap((id) => byId.get(id) ?? []);
    if (kept === undefined || merged.length === 0) continue;
    const validFrom = [kept, ...merged].map((fact) => fact.validFrom).toSorted()[0] ?? kept.validFrom;
    upserts.push({ ...kept, confidence: merged.reduce((sum, fact) => reinforce(sum, fact.confidence), kept.confidence), validFrom });
    for (const fact of merged) expire.push({ id: fact.id, at });
  }
  return { upserts, expire };
}
