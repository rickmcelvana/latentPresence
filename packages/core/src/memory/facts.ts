import type { SemanticFact } from '@latentpresence/protocol';

/**
 * How newly heard facts meet the ones already believed (P4-T03). Pure: given the current
 * facts and what the extractor read from an exchange, it says what to write — the kernel
 * does the writing.
 *
 * Three outcomes for each extracted fact:
 *
 * - **reinforced** — the same subject, predicate and object is already believed: its
 *   confidence rises (two independent witnesses, `1 − (1 − a)(1 − b)`) instead of a second
 *   row appearing;
 * - **supersedes** — it names a fact it replaces (`replaces`), or its predicate is
 *   single-valued (`lives_in`, `works_at`, …) and the subject already has a different value:
 *   the old one's validity is closed where the new one's starts (bi-temporal, ADR-05);
 * - **new** — otherwise.
 *
 * A fact replaced before it ever began — "starting October" said in September, then a move
 * before October — never became true, so it is **expired** (the store stops believing the
 * record) rather than given a validity that ends where it starts.
 *
 * Canonical form is lowercase snake_case for subject and predicate, trimmed text for the
 * object compared case-insensitively, so "User lives in" and "user lives_in" are one fact.
 */

/** Predicates a subject has one value of at a time. A new value closes the old one. */
export const SINGLE_VALUED_PREDICATES: ReadonlySet<string> = new Set([
  'name',
  'age',
  'birthday',
  'lives_in',
  'works_at',
  'job',
  'job_title',
  'work_schedule',
  'works_schedule',
  'works_shifts',
  'shift',
  'employer',
  'partner',
  'spouse',
  'relationship_status',
  'favorite_color',
  'favorite_food',
  'hometown',
  'pronouns',
  'timezone',
  'studies_at',
]);

export interface ExtractedFact {
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly confidence: number;
  /** When it became true, if the exchange said; ISO-8601. */
  readonly validFrom: string | null;
  /** The id of a known fact this one replaces, if the extractor named one. */
  readonly replaces: string | null;
}

export function canonicalTerm(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}]+/gu, '_')
    .replaceAll(/^_+|_+$/g, '');
}

function sameObject(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Two independent readings of the same fact. */
export function reinforce(a: number, b: number): number {
  return Math.min(1, 1 - (1 - a) * (1 - b));
}

export interface FactWrites {
  /** Facts to write: new ones, and reinforced ones with their raised confidence. */
  readonly upserts: SemanticFact[];
  /** Facts whose validity ends, and when. */
  readonly supersede: { readonly id: string; readonly validTo: string }[];
  /** Facts replaced before they began: the record was wrong, not the world changed. */
  readonly expire: { readonly id: string; readonly at: string }[];
}

export interface PlanFactsOptions {
  readonly characterId: string;
  readonly now: string;
  readonly newId: () => string;
  readonly sourceEpisodeId: string | null;
  readonly singleValued?: ReadonlySet<string>;
}

function isCurrent(fact: SemanticFact, now: string): boolean {
  return fact.validTo === null || fact.validTo > now;
}

/**
 * What to write for `extracted`, given `known` (the character's current facts). Applies the
 * facts in order against a working copy, so two extracted facts in one exchange — "I moved
 * from Toronto to Halifax" — see each other.
 */
export function planFactWrites(
  known: readonly SemanticFact[],
  extracted: readonly ExtractedFact[],
  options: PlanFactsOptions,
  ended: readonly string[] = [],
): FactWrites {
  const singleValued = options.singleValued ?? SINGLE_VALUED_PREDICATES;
  const working = new Map(known.filter((fact) => fact.characterId === options.characterId && isCurrent(fact, options.now)).map((fact) => [fact.id, fact]));
  const upserts = new Map<string, SemanticFact>();
  const supersede = new Map<string, string>();
  const expire = new Set<string>();

  /** End `old` at `at`: expired if it never began, superseded if stored, closed in place if new. */
  const close = (old: SemanticFact, at: string): void => {
    const stored = known.some((fact) => fact.id === old.id);
    working.delete(old.id);
    if (at <= old.validFrom) {
      // It never began (a plan that changed, or the same moment): never true at all. An
      // interval ending where it starts would also still count as current until then.
      if (stored) expire.add(old.id);
      upserts.delete(old.id);
    } else if (stored) {
      // A reinforcement earlier in this exchange would be written after the close and
      // reopen it, so the close wins.
      supersede.set(old.id, at);
      upserts.delete(old.id);
    } else {
      // Heard and replaced in one exchange ("I moved from Toronto to Halifax"): kept, closed.
      upserts.set(old.id, { ...old, validTo: at });
    }
  };
  const rivals = (subject: string, predicate: string, except: string): SemanticFact[] =>
    singleValued.has(predicate) ? [...working.values()].filter((fact) => fact.subject === subject && fact.predicate === predicate && fact.id !== except) : [];

  for (const raw of extracted) {
    const subject = canonicalTerm(raw.subject);
    const predicate = canonicalTerm(raw.predicate);
    const object = raw.object.trim();
    if (subject === '' || predicate === '' || object === '') continue;
    const confidence = Math.min(1, Math.max(0, raw.confidence));
    const startsAt = raw.validFrom ?? options.now;

    const same = [...working.values()].find((fact) => fact.subject === subject && fact.predicate === predicate && sameObject(fact.object, object));
    if (same !== undefined) {
      // Restated as true from earlier than believed — "day shifts from October", then in
      // September "still on days" — it holds from then, and a single-valued rival ends then.
      const earlier = startsAt < same.validFrom;
      const raised = { ...same, confidence: reinforce(same.confidence, confidence), ...(earlier ? { validFrom: startsAt } : {}) };
      if (earlier) for (const rival of rivals(subject, predicate, same.id)) close(rival, startsAt);
      working.set(same.id, raised);
      upserts.set(same.id, raised);
      continue;
    }

    const closes = [...working.values()].filter((fact) => fact.id === raw.replaces);
    for (const rival of rivals(subject, predicate, '')) if (!closes.includes(rival)) closes.push(rival);
    for (const old of closes) close(old, startsAt);

    const fact: SemanticFact = {
      id: options.newId(),
      characterId: options.characterId,
      subject,
      predicate,
      object,
      confidence,
      validFrom: startsAt,
      validTo: null,
      recordedAt: options.now,
      sourceEpisodeId: options.sourceEpisodeId,
      embedding: null,
    };
    working.set(fact.id, fact);
    upserts.set(fact.id, fact);
  }

  // Ended with nothing in their place: "the half marathon is off". Only known, current facts
  // — an id the model invented, or one this exchange already closed, is ignored.
  for (const id of ended) {
    const old = working.get(id);
    if (old === undefined || !known.some((fact) => fact.id === id)) continue;
    working.delete(id);
    upserts.delete(id);
    if (options.now <= old.validFrom) expire.add(id);
    else supersede.set(id, options.now);
  }

  return {
    upserts: [...upserts.values()],
    supersede: [...supersede.entries()].map(([id, validTo]) => ({ id, validTo })),
    expire: [...expire].map((id) => ({ id, at: options.now })),
  };
}
