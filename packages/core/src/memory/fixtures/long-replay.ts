import type { SemanticFact } from '@latentpresence/protocol';
import type { ScriptedExchange } from './thirty-turns';

/**
 * The P6-T04 replay: one person, Sam, over twelve evenings in three months — about twenty things
 * about their life, each told once and then **retold in other words** session after session, the
 * way people do ("I love jazz", "jazz is my thing", "been on a Coltrane kick"), with small talk
 * between and a trickle of genuinely new things late on. What a companion should end up
 * believing grows with what is new, not with how often the old is said: the done-when is that the
 * fact count grows sublinearly and that what is said twice in other words ends as one fact.
 *
 * Built, not written out: each topic has its phrasings, sessions retell earlier topics in turn,
 * so the transcript is long without being hand-copied. Deterministic — the same every build.
 */

/** subject, predicate, object. */
export type Triple = readonly [string, string, string];

export interface LifeTopic {
  readonly id: string;
  /** The first session it is mentioned in (0-based). */
  readonly from: number;
  /** Ways Sam says it; the first is how it is first told. */
  readonly lines: readonly string[];
  /**
   * What an extractor that ignores the known facts writes for each line, in that line's own
   * wording — a weaker model's habit, or two tabs extracting at once. Parallel to `lines`.
   */
  readonly writes: readonly Triple[];
  readonly reply: string;
  /**
   * Matches a current fact that states it, as `subject predicate object`. At the end exactly one
   * should: none is forgotten, two is a duplicate that sleep did not merge.
   */
  readonly fact: RegExp;
}

export const LIFE: readonly LifeTopic[] = [
  { id: 'name', from: 0, lines: ["Hi, I'm Sam.", "It's Sam again, hi!", 'Sam here — evening!'], writes: [['user','name','Sam'],['user','name','Sam'],['user','name','Sam']], reply: 'Hi Sam, good to see you.', fact: /^user name sam/iu },
  { id: 'halifax', from: 0, lines: ['I live in Halifax.', "Foggy again here in Halifax, it's that time of year.", "Halifax is home — can't imagine living anywhere else.", 'Living in Halifax means you own a lot of rain gear.'], writes: [['user','lives_in','Halifax'],['user','lives_in','Halifax, Nova Scotia'],['user','location','Halifax'],['user','lives_in','Halifax']], reply: 'Halifax sounds lovely, fog and all.', fact: /^user lives_in halifax/iu },
  { id: 'job', from: 0, lines: ["I'm a software developer.", 'I write code for a living, mostly backend stuff.', 'Being a programmer, I spend half my day in code review.', 'Developer life: another day of fixing other people’s bugs.'], writes: [['user','job','software developer'],['user','works_as','programmer'],['user','profession','programmer'],['user','job','developer']], reply: 'Sounds like a busy job.', fact: /^user (job|occupation|profession|works_as) .*(develop|program|engineer|coder|code)/iu },
  { id: 'employer', from: 0, lines: ['I work at Tidewater Pay, a little payments company.', 'Big release day at Tidewater today.', "Tidewater Pay's office finally got decent coffee."], writes: [['user','works_at','Tidewater Pay'],['user','employer','Tidewater'],['user','works_at','Tidewater Pay']], reply: 'Tidewater Pay, nice.', fact: /^user (works_at|employer|works_for) .*tidewater/iu },
  { id: 'partner', from: 1, lines: ['My partner Jess and I have been together six years.', 'Jess, my partner, says hi.', 'Date night with Jess tonight.'], writes: [['user','partner','Jess'],['user','partner','Jess'],['user','partner','Jess']], reply: 'Say hi to Jess for me.', fact: /^user (partner|spouse|significant_other|in_relationship_with) .*jess/iu },
  { id: 'jess-teacher', from: 1, lines: ['Jess teaches grade four.', "Jess is marking her grade four class's projects all weekend.", "Being a primary school teacher wears Jess out in September."], writes: [['jess','job','grade four teacher'],['jess','teaches','grade four'],['jess','occupation','primary school teacher']], reply: 'Teaching is a lot of work.', fact: /^(jess|partner|partner_jess) (job|occupation|profession|works_as|teaches) .*(teach|grade|school)/iu },
  { id: 'dog', from: 1, lines: ['We have a beagle called Biscuit.', 'Biscuit, our beagle, stole a sandwich today.', 'Walked Biscuit along the harbour this morning.', 'Biscuit the dog is snoring next to me.'], writes: [['user','has_pet','beagle named Biscuit'],['user','has_dog','Biscuit, a beagle'],['user','has_pet','Biscuit'],['user','pet','Biscuit the dog']], reply: 'Biscuit sounds like a character.', fact: /^user (has_pet|has_dog|owns|pet|dog) .*biscuit/iu },
  { id: 'jazz', from: 2, lines: ['I love jazz.', "Jazz is my thing — I'd listen to it all day.", "I'm really into jazz, Coltrane especially.", 'Put on some jazz while cooking, as usual.'], writes: [['user','likes','jazz'],['user','loves','Jazz'],['user','is_into','jazz'],['user','favorite_music','jazz']], reply: 'Jazz is great company.', fact: /^user (likes|loves|enjoys|favorite_music|favourite_music|into|music_taste|listens_to) .*jazz/iu },
  { id: 'guitar', from: 2, lines: ['I play guitar.', "I've been playing guitar since I was twelve.", 'My guitar needs new strings again.'], writes: [['user','plays','guitar'],['user','plays','the guitar'],['user','plays_instrument','guitar']], reply: 'Guitar, nice.', fact: /^user (plays|plays_instrument|hobby|instrument|plays_guitar|likes) .*guitar/iu },
  { id: 'shellfish', from: 2, lines: ["I'm allergic to shellfish.", "Can't do the seafood platter — shellfish allergy.", 'Shellfish and I do not get along, allergy-wise.'], writes: [['user','allergic_to','shellfish'],['user','allergy','shellfish'],['user','allergic_to','Shellfish.']], reply: 'Good to know about the shellfish.', fact: /^user (allergic_to|allergy|has_allergy) .*shellfish/iu },
  { id: 'vegetarian', from: 3, lines: ["I'm vegetarian.", "I haven't eaten meat in ten years.", 'Being veggie in a seafood town is interesting.'], writes: [['user','diet','vegetarian'],['user','is','vegetarian'],['user','diet','vegetarian']], reply: 'Vegetarian in Halifax, that takes planning.', fact: /^user (is|diet|dietary_preference|eats|is_vegetarian|follows_diet) .*(vegetarian|veggie)/iu },
  { id: 'running', from: 3, lines: ['I go running three times a week.', 'Did an 8k run this morning.', 'Running keeps me sane, honestly.'], writes: [['user','hobby','running'],['user','likes','running'],['user','hobby','Running']], reply: 'Running is a good habit.', fact: /^user ((hobby|likes|enjoys|exercise|activity|does) .*(run|jog)|(runs|goes_running|running))/iu },
  { id: 'sister', from: 3, lines: ['My sister Maya lives in Montreal.', 'Maya — my sister in Montreal — called today.', 'Going to visit Maya in Montreal next month maybe.'], writes: [['user','has_sibling','sister Maya'],['user','has_sibling','Maya (sister)'],['user','has_sibling','sister Maya']], reply: 'Montreal is a fun city to visit.', fact: /^(user has_sibling .*maya|user sister .*maya|maya (is|relation|relationship) .*sister|sister name maya)/iu },
  { id: 'sister-city', from: 3, lines: ['My sister Maya lives in Montreal.', 'Maya loves Montreal, she moved there for school and stayed.'], writes: [['maya','lives_in','Montreal'],['maya','lives_in','Montreal']], reply: 'Sounds like Montreal suits her.', fact: /^(maya|sister|sister_maya) lives_in montr/iu },
  { id: 'birthday', from: 4, lines: ['My birthday is March 3rd.', 'I was born on the third of March, a Pisces apparently.'], writes: [['user','birthday','March 3'],['user','birthday','3 March']], reply: 'March 3rd, noted.', fact: /^user birthday .*(03|march)/iu },
  { id: 'hometown', from: 4, lines: ['I grew up in Moncton.', "Moncton is where I'm from originally.", 'Back in Moncton, where I grew up, it was all hockey.'], writes: [['user','hometown','Moncton'],['user','grew_up_in','Moncton'],['user','from','Moncton']], reply: 'Moncton, nice.', fact: /^user (hometown|grew_up_in|from|born_in) .*moncton/iu },
  { id: 'coffee', from: 4, lines: ['I drink way too much coffee.', 'Third coffee of the day, oops.', "Coffee is basically my personality at this point."], writes: [['user','likes','coffee'],['user','drinks','a lot of coffee'],['user','loves','coffee']], reply: 'Coffee is a fine personality.', fact: /^user (likes|loves|drinks|enjoys|habit) .*coffee/iu },
  { id: 'french', from: 5, lines: ["I'm learning French.", 'Trying to get my French better before we visit Montreal.', 'French lesson tonight, my verbs are a disaster.'], writes: [['user','learning','French'],['user','goal','learn French'],['user','learning','French']], reply: 'Bonne chance with the French!', fact: /^user (goal|learning|is_learning|studies|studying|plans_to|learns) .*french/iu },
  { id: 'winter', from: 5, lines: ["I can't stand winter.", 'Winter is the worst season, fight me.', 'Already dreading winter.'], writes: [['user','dislikes','winter'],['user','hates','winter'],['user','dislikes','Winter']], reply: 'Winter is a lot.', fact: /^user (dislikes|hates|doesn't_like) .*winter/iu },
  { id: 'dune', from: 5, lines: ['Dune is my favourite book.', 'Rereading Dune again — still the best book ever.'], writes: [['user','favorite_book','Dune'],['user','favourite_book','Dune']], reply: 'Dune is a classic.', fact: /^user (favorite_book|favourite_book|likes|loves) .*dune/iu },
];

/** Things said once, late: real growth, a little each evening. */
export const NEW_LATE: readonly { readonly session: number; readonly line: string; readonly reply: string; readonly writes: Triple }[] = [
  { session: 7, line: 'Jess and I booked a trip to Iceland for June!', reply: 'Iceland in June, amazing.', writes: ['user', 'plans_to', 'travel to Iceland in June'] },
  { session: 8, line: 'I started a pottery class on Thursdays.', reply: 'Pottery! Fun.', writes: ['user', 'takes_class', 'pottery on Thursdays'] },
  { session: 9, line: 'We might adopt a second dog, a rescue greyhound.', reply: 'A greyhound and a beagle, ha.', writes: ['user', 'plans_to', 'adopt a rescue greyhound'] },
  { session: 10, line: 'My mum is retiring in December.', reply: 'That is a big change for her.', writes: ['mum', 'plans_to', 'retire in December'] },
  { session: 11, line: 'I signed up for a half marathon in May.', reply: 'A half marathon, great goal.', writes: ['user', 'plans_to', 'run a half marathon in May'] },
];

const SMALL_TALK: readonly [string, string][] = [
  ['How are you doing tonight?', "I'm good, thanks for asking!"],
  ['Ha, that is funny.', 'Glad it made you laugh.'],
  ['Tell me something interesting.', 'Octopuses have three hearts.'],
  ['Long day.', 'Sounds like it. Want to talk about it?'],
  ['Anyway.', 'Anyway!'],
  ['What do you think about the weather lately?', 'I hear it has been changeable.'],
];

export const LONG_SESSIONS = 12;

function at(session: number, minute: number): string {
  const day = new Date(Date.UTC(2026, 6, 1 + session * 8, 23, 0) + minute * 60_000);
  return day.toISOString();
}

/**
 * The twelve evenings: each tells the topics that begin then, retells about a third of the
 * earlier ones in another phrasing, says the late news, and makes small talk between.
 */
function build(): ScriptedExchange[] {
  const exchanges: ScriptedExchange[] = [];
  for (let session = 0; session < LONG_SESSIONS; session += 1) {
    const lines: [string, string][] = [];
    for (const [index, topic] of LIFE.entries()) {
      if (topic.from === session) lines.push([topic.lines[0] ?? '', topic.reply]);
      else if (topic.from < session && (index + session) % 3 === 0) lines.push([topic.lines[(session + index) % topic.lines.length] ?? '', topic.reply]);
    }
    for (const late of NEW_LATE) if (late.session === session) lines.push([late.line, late.reply]);
    const talk = SMALL_TALK[session % SMALL_TALK.length];
    const more = SMALL_TALK[(session + 3) % SMALL_TALK.length];
    if (talk !== undefined) lines.splice(1, 0, talk);
    if (more !== undefined) lines.push(more);
    for (const [minute, [user, assistant]] of lines.entries()) exchanges.push({ session: `long-${session}`, at: at(session, minute), user, assistant });
  }
  return exchanges;
}

export const LONG_REPLAY: readonly ScriptedExchange[] = build();

/** How many current facts state each topic: 1 is right, 0 forgotten, 2 or more not merged. */
export function topicCounts(current: readonly SemanticFact[]): Record<string, number> {
  const lines = current.map((fact) => `${fact.subject} ${fact.predicate} ${fact.object}`);
  return Object.fromEntries(LIFE.map((topic) => [topic.id, lines.filter((line) => topic.fact.test(line)).length]));
}

/** Every line Sam says, with what a forgetful extractor writes for it (a line told for two topics writes both). */
export const FORGETFUL_WRITES: ReadonlyMap<string, readonly Triple[]> = (() => {
  const map = new Map<string, Triple[]>();
  for (const topic of LIFE) for (const [index, line] of topic.lines.entries()) map.set(line, [...(map.get(line) ?? []), ...(topic.writes[index] === undefined ? [] : [topic.writes[index]])]);
  for (const late of NEW_LATE) map.set(late.line, [late.writes]);
  return map;
})();
