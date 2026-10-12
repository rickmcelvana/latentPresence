import type { LastConversation } from './last';
import { partOfDayWords, sinceWords } from './words';

/**
 * The prompt's time sections (P6-T02, ADR-51): when they last talked and how it ended, and, when
 * she is about to speak first, how to open. Both sit just before `RIGHT NOW`.
 */

export function renderSince(since: LastConversation, now: Date): string[] {
  return [
    'LAST TIME YOU TALKED',
    `- You last talked with them ${sinceWords(new Date(since.at), now)}.`,
    ...(since.turns.length === 0
      ? []
      : ['- It ended like this:', ...since.turns.map((turn) => `  ${turn.role === 'user' ? 'They said' : 'You said'}: "${turn.text}"`)]),
    '- Let the time that has passed show the way it would with a friend: after a few hours there',
    '  is nothing to remark on; after days, it has been a while. Say it in everyday words, never',
    '  as a number of hours.',
    '',
  ];
}

export function renderOpening(now: Date): string[] {
  return [
    'YOU SPEAK FIRST',
    '- They have just come back to the call and have not said anything yet. Speak first: a',
    '  greeting and one thing, two or three short sentences in all, with one question at most.',
    `- Greet them for the time of day it is for them: it is ${partOfDayWords(now).replace(/^(in|at) /u, '')}.`,
    // The live check: "how it ended" got "How's your Tuesday starting off?" — nothing from last time.
    '- Then pick up one thing from last time, the way a friend would: a follow-up that is due now',
    '  if there is one, otherwise what you were talking about. Ask about it, do not retell it.',
    '- Do not recite what was said or list what you know. Ask, then stop and let them talk.',
    // They have not answered yet; and the opener is asked with no tools (ADR-51).
    '- A follow-up you bring up stays until they have answered; cancel it then.',
    '',
  ];
}
