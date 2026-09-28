import type { SemanticFact } from '@latentpresence/protocol';

/**
 * The P4-T03 replay: thirty things one person says to the character over three sessions in
 * a month, and what she should believe at the end. Written to test the hard cases, not the
 * easy ones: a move (single-valued `lives_in`), two job changes, a correction of a fact that
 * is *not* single-valued (the allergy — only `replaces` can close it), a goal given up, a
 * relationship that changes status, facts about someone else (the sister), and turns with
 * nothing durable in them at all.
 *
 * `live:memory` runs it through a real model and records every reply
 * (`thirty-turns.recording.ts`); the unit test replays the recording with no model and
 * holds the kernel to `EXPECTED_CURRENT` and `EXPECTED_CLOSED`.
 */

export interface ScriptedExchange {
  readonly session: string;
  readonly at: string;
  readonly user: string;
  readonly assistant: string;
}

export const THIRTY_TURNS: readonly ScriptedExchange[] = [
  { session: 's1', at: '2026-09-01T20:00:00.000Z', user: "Hi! I'm Jordan, by the way. First time trying this.", assistant: 'Hi Jordan, lovely to meet you. What made you want to try it?' },
  { session: 's1', at: '2026-09-01T20:01:00.000Z', user: 'I live in Toronto, in a tiny apartment near Kensington Market.', assistant: 'Kensington is such a lively spot. Tiny can be cosy, too.' },
  { session: 's1', at: '2026-09-01T20:02:00.000Z', user: "I work as a nurse at St. Michael's Hospital, mostly night shifts.", assistant: 'Nights are tough. How long have you been doing them?' },
  { session: 's1', at: '2026-09-01T20:03:00.000Z', user: "Honestly the night shifts are wrecking me today, I'm so tired.", assistant: "That sounds exhausting. Be gentle with yourself tonight." },
  { session: 's1', at: '2026-09-01T20:04:00.000Z', user: "I have a cat called Miso. She's twelve and very grumpy.", assistant: 'A grumpy twelve-year-old cat named Miso is perfect.' },
  { session: 's1', at: '2026-09-01T20:05:00.000Z', user: 'My sister Priya lives in Vancouver, we video call on Sundays.', assistant: 'Sunday calls with Priya sound like a lovely ritual.' },
  { session: 's1', at: '2026-09-01T20:06:00.000Z', user: "What's the weather usually like where you are?", assistant: "I don't have weather of my own, but I love hearing about yours." },
  { session: 's1', at: '2026-09-01T20:07:00.000Z', user: "I'm allergic to peanuts, which makes eating out a pain.", assistant: 'That must take a lot of checking menus. Sorry.' },
  { session: 's1', at: '2026-09-01T20:08:00.000Z', user: 'Love Thai food though. Green curry is my favourite.', assistant: 'Green curry is a great favourite.' },
  { session: 's1', at: '2026-09-01T20:09:00.000Z', user: 'Anyway, I should sleep. Talk tomorrow?', assistant: 'Sleep well, Jordan. Talk soon.' },

  { session: 's2', at: '2026-09-10T18:00:00.000Z', user: 'Big news — I got a new job! Day shifts at Toronto General starting October.', assistant: 'Congratulations! Days at Toronto General, that is huge.' },
  { session: 's2', at: '2026-09-10T18:01:00.000Z', user: "Still nursing, just no more nights. I'm so relieved.", assistant: 'Your body is going to thank you.' },
  { session: 's2', at: '2026-09-10T18:02:00.000Z', user: 'My partner Alex is thrilled too, they hated my schedule.', assistant: "I'm glad Alex gets more of you now." },
  { session: 's2', at: '2026-09-10T18:03:00.000Z', user: "We're thinking about getting a dog but Miso would riot.", assistant: 'Miso might have opinions about that, yes.' },
  { session: 's2', at: '2026-09-10T18:04:00.000Z', user: "Did I tell you I run? I'm training for a half marathon in November.", assistant: 'A half marathon! How is training going?' },
  { session: 's2', at: '2026-09-10T18:05:00.000Z', user: "My knee's been sore after long runs lately.", assistant: 'Keep an eye on that knee.' },
  { session: 's2', at: '2026-09-10T18:06:00.000Z', user: 'What do you think about podcasts for running?', assistant: 'Podcasts can make the long runs fly by.' },
  { session: 's2', at: '2026-09-10T18:07:00.000Z', user: 'I mostly listen to true crime podcasts. Weird, I know.', assistant: 'Not weird at all, lots of people love them.' },
  { session: 's2', at: '2026-09-10T18:08:00.000Z', user: "Priya's visiting next weekend, first time in two years!", assistant: 'Two years! That visit is going to be special.' },
  { session: 's2', at: '2026-09-10T18:09:00.000Z', user: 'Okay I have to get to the gym. Bye!', assistant: 'Have a good workout!' },

  { session: 's3', at: '2026-09-24T19:00:00.000Z', user: "So... Alex and I moved! We're in Halifax now.", assistant: 'Halifax! That is a big change. How are you settling in?' },
  { session: 's3', at: '2026-09-24T19:01:00.000Z', user: 'I transferred to the QEII Health Sciences Centre, still on days.', assistant: 'Good that you kept the day shifts.' },
  { session: 's3', at: '2026-09-24T19:02:00.000Z', user: "Miso hated the flight but she's settling in.", assistant: 'Poor Miso. Cats forgive eventually.' },
  { session: 's3', at: '2026-09-24T19:03:00.000Z', user: "Oh, and I finally got tested — it's actually tree nuts I'm allergic to, not peanuts.", assistant: 'That is good to know properly after all this time.' },
  { session: 's3', at: '2026-09-24T19:04:00.000Z', user: "The half marathon is off, my knee needs rest. Physio says six weeks.", assistant: "I'm sorry. Rest is the right call." },
  { session: 's3', at: '2026-09-24T19:05:00.000Z', user: "I've started learning to knit instead. It's very calming.", assistant: 'Knitting! What a lovely switch.' },
  { session: 's3', at: '2026-09-24T19:06:00.000Z', user: "Alex proposed last night!! We're engaged!", assistant: 'Oh Jordan, congratulations to you both!' },
  { session: 's3', at: '2026-09-24T19:07:00.000Z', user: "Priya's coming for the engagement party in December.", assistant: 'Priya will love being there for that.' },
  { session: 's3', at: '2026-09-24T19:08:00.000Z', user: 'What should I knit first, a scarf or a hat?', assistant: 'A scarf is a forgiving first project.' },
  { session: 's3', at: '2026-09-24T19:09:00.000Z', user: "I'm going with a scarf for Alex. Night!", assistant: 'Alex is lucky. Goodnight!' },
];

/** A fact the end state should (or must not) hold, by pattern rather than exact wording. */
export interface FactMatcher {
  readonly what: string;
  readonly subject: RegExp;
  readonly predicate: RegExp;
  readonly object: RegExp;
  /** Another way to say the same thing ("sister name Priya" for "user has_sibling Priya"). */
  readonly or?: Omit<FactMatcher, 'what' | 'or'>;
}

function matches(fact: SemanticFact, matcher: FactMatcher): boolean {
  const one = (m: Omit<FactMatcher, 'what' | 'or'>): boolean => m.subject.test(fact.subject) && m.predicate.test(fact.predicate) && m.object.test(fact.object);
  return one(matcher) || (matcher.or !== undefined && one(matcher.or));
}

const USER = /^user$/;

/** Every one of these must be believed at the end. */
export const EXPECTED_CURRENT: readonly FactMatcher[] = [
  { what: 'their name', subject: USER, predicate: /^name$/, object: /jordan/i },
  { what: 'they live in Halifax', subject: USER, predicate: /^lives_in$/, object: /halifax/i },
  { what: 'they are a nurse', subject: USER, predicate: /^(job|job_title|occupation|profession|works_as)$/, object: /nurs/i },
  { what: 'they work at the QEII', subject: USER, predicate: /^(works_at|employer)$/, object: /qeii|queen elizabeth/i },
  { what: 'their cat Miso', subject: USER, predicate: /^has_(pet|cat)$/, object: /miso/i },
  { what: 'their sister Priya', subject: USER, predicate: /^has_(sibling|sister)$/, object: /priya/i, or: { subject: /^sister/, predicate: /^name$/, object: /priya/i } },
  { what: 'Priya lives in Vancouver', subject: /priya|sister/, predicate: /^lives_in$/, object: /vancouver/i },
  { what: 'allergic to tree nuts', subject: USER, predicate: /^allergic_to$/, object: /tree nut/i },
  { what: 'green curry or Thai food', subject: USER, predicate: /^(favorite_food|likes|loves)$/, object: /curry|thai/i },
  { what: 'their partner Alex', subject: USER, predicate: /^(partner|fiance|fiancee|engaged_to|spouse)$/, object: /alex/i },
  { what: 'true crime podcasts', subject: USER, predicate: /^(likes|listens_to|enjoys)$/, object: /true crime/i },
  { what: 'knitting', subject: USER, predicate: /^(hobby|likes|enjoys|learning|is_learning|has_hobby|started_learning)$/, object: /knit/i },
];

/** None of these may still be believed at the end: each was replaced by something later. */
export const EXPECTED_CLOSED: readonly FactMatcher[] = [
  { what: 'lives in Toronto', subject: USER, predicate: /^lives_in$/, object: /toronto/i },
  { what: "works at St. Michael's", subject: USER, predicate: /^(works_at|employer)$/, object: /michael/i },
  { what: 'works at Toronto General', subject: USER, predicate: /^(works_at|employer)$/, object: /toronto general/i },
  { what: 'allergic to peanuts', subject: USER, predicate: /^allergic_to$/, object: /^(?!.*tree).*peanut/i },
  { what: 'training for a half marathon', subject: USER, predicate: /.*/, object: /half marathon/i },
  { what: 'works night shifts', subject: USER, predicate: /shift|schedule/, object: /night/i },
];

export interface FactScore {
  readonly missing: readonly string[];
  readonly stale: readonly string[];
  /** Current facts no matcher expected: extras, which the model is allowed but which cost precision. */
  readonly extra: readonly SemanticFact[];
}

export function scoreFacts(current: readonly SemanticFact[]): FactScore {
  const missing = EXPECTED_CURRENT.filter((matcher) => !current.some((fact) => matches(fact, matcher))).map((matcher) => matcher.what);
  const stale = EXPECTED_CLOSED.filter((matcher) => current.some((fact) => matches(fact, matcher))).map((matcher) => matcher.what);
  const extra = current.filter((fact) => !EXPECTED_CURRENT.some((matcher) => matches(fact, matcher)));
  return { missing, stale, extra };
}
