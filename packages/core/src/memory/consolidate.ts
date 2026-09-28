import type { SemanticFact } from '@latentpresence/protocol';
import { SINGLE_VALUED_PREDICATES, reinforce } from './facts';

/**
 * The "sleep" pass over a character's current facts (P4-T03, ADR-37). Pure: it says what
 * to change, the kernel changes it. Three rules, in order:
 *
 * 1. **Duplicates merge.** The same subject, predicate and object believed twice (two
 *    extractions that raced, or a store written by something else) keep the earliest record,
 *    with the confidences combined; the others are **expired** — the store stops believing
 *    the copy, the world did not change.
 * 2. **A single-valued predicate keeps one value.** If a subject still has two (`lives_in`
 *    Toronto and Halifax), the one that became true latest stays and the others are
 *    **superseded** where it began — that is a change in the world.
 * 3. **Forgetting.** A fact nobody has confirmed, below `forgetBelow` and recorded more than
 *    `forgetAfterDays` ago, is expired. Nothing is deleted, ever: expiry only takes a fact out
 *    of retrieval, and what she believed on any day can still be asked.
 *
 * Confidence rises when a fact is heard again (`planFactWrites`), so what is repeated stays
 * above the line and what was said once, hedged, long ago, fades.
 */

export interface ForgettingPolicy {
  readonly forgetBelow: number;
  readonly forgetAfterDays: number;
}

export const DEFAULT_FORGETTING: ForgettingPolicy = { forgetBelow: 0.35, forgetAfterDays: 30 };

export interface ConsolidationPlan {
  readonly upserts: SemanticFact[];
  readonly expire: { readonly id: string; readonly at: string }[];
  readonly supersede: { readonly id: string; readonly validTo: string }[];
}

const DAY_MS = 86_400_000;

function key(...parts: string[]): string {
  return parts.map((part) => part.trim().toLowerCase()).join('\u0000');
}

function earliestFirst(a: SemanticFact, b: SemanticFact): number {
  return a.recordedAt.localeCompare(b.recordedAt) || a.id.localeCompare(b.id);
}

export function consolidateFacts(
  facts: readonly SemanticFact[],
  now: Date,
  policy: ForgettingPolicy = DEFAULT_FORGETTING,
  singleValued: ReadonlySet<string> = SINGLE_VALUED_PREDICATES,
): ConsolidationPlan {
  const at = now.toISOString();
  const upserts = new Map<string, SemanticFact>();
  const expire = new Map<string, string>();
  const supersede = new Map<string, string>();

  // 1. Duplicates.
  const groups = new Map<string, SemanticFact[]>();
  for (const fact of facts) {
    const group = groups.get(key(fact.characterId, fact.subject, fact.predicate, fact.object)) ?? [];
    group.push(fact);
    groups.set(key(fact.characterId, fact.subject, fact.predicate, fact.object), group);
  }
  const survivors: SemanticFact[] = [];
  for (const group of groups.values()) {
    const [kept, ...copies] = group.toSorted(earliestFirst);
    if (kept === undefined) continue;
    if (copies.length === 0) {
      survivors.push(kept);
      continue;
    }
    const merged = { ...kept, confidence: copies.reduce((sum, copy) => reinforce(sum, copy.confidence), kept.confidence) };
    upserts.set(merged.id, merged);
    for (const copy of copies) expire.set(copy.id, at);
    survivors.push(merged);
  }

  // 2. One value per single-valued predicate.
  const bySlot = new Map<string, SemanticFact[]>();
  for (const fact of survivors) {
    if (!singleValued.has(fact.predicate)) continue;
    const slot = key(fact.characterId, fact.subject, fact.predicate);
    bySlot.set(slot, [...(bySlot.get(slot) ?? []), fact]);
  }
  const closed = new Set<string>();
  for (const slot of bySlot.values()) {
    if (slot.length < 2) continue;
    const latest = slot.toSorted((a, b) => b.validFrom.localeCompare(a.validFrom) || b.recordedAt.localeCompare(a.recordedAt))[0];
    if (latest === undefined) continue;
    for (const fact of slot) {
      if (fact.id === latest.id) continue;
      supersede.set(fact.id, fact.validFrom > latest.validFrom ? fact.validFrom : latest.validFrom);
      upserts.delete(fact.id);
      closed.add(fact.id);
    }
  }

  // 3. Forgetting.
  for (const fact of survivors) {
    if (closed.has(fact.id)) continue;
    const age = now.getTime() - Date.parse(fact.recordedAt);
    if (fact.confidence < policy.forgetBelow && age > policy.forgetAfterDays * DAY_MS) {
      expire.set(fact.id, at);
      upserts.delete(fact.id);
    }
  }

  return {
    upserts: [...upserts.values()],
    expire: [...expire.entries()].map(([id, when]) => ({ id, at: when })),
    supersede: [...supersede.entries()].map(([id, validTo]) => ({ id, validTo })),
  };
}
