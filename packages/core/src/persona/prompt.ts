import {
  CharacterEmotionSchema,
  CharacterGestureSchema,
  UserEmotionSchema,
  type Persona,
  type PromptContextInput,
} from '@latentpresence/protocol';
import { describeFeeling, describeUser } from '../affect/express';

/**
 * The system prompt (P1-T12): a persona plus what is true right now, rendered to the
 * text a model is actually given.
 *
 * **Pure, and that is the point.** Everything that varies — the clock, the user's name,
 * later the mood and the memories — arrives in `context`, so the function is snapshot
 * testable and two runs of `pnpm live:persona` differ only where they are meant to.
 *
 * **Every line here was paid for by the pilot** (`docs/SURFACE.md`, "System prompts and
 * inline tags"), which ran a draft of this text against two models before the protocol
 * was designed. What it found was that tags are the easy part — a strong model followed
 * the grammar six times out of six — and that the failures worth writing rules about are
 * a model answering in the wrong language, and a model narrating its feelings in prose
 * (`*smiles*`) instead of tagging them. Both have a line below.
 *
 * It is sent as `instructions`, never as a `system` message: AI SDK 7 throws on the
 * latter, which is why no system prompt reached a model before 67dd675.
 */

/** The user emotions a model is offered: `other` and `unknown` are for sensors, not for a reader. */
const USER_READINGS = UserEmotionSchema.options.filter((label) => label !== 'other' && label !== 'unknown');

/** How the expressiveness level is said to a model, which cannot read a number. */
const GESTURE_GUIDANCE = {
  rare: 'Use a gesture only when it really adds something — a few times in a conversation.',
  some: 'Use a gesture where a person naturally would, perhaps every few replies.',
  often: 'Use gestures freely, most replies, the way an animated talker does.',
} as const;

export function renderSystemPrompt(persona: Persona, context: PromptContextInput): string {
  const userName = context.userName ?? null;
  const affect = context.affect ?? null;
  const feeling = affect === null ? null : describeFeeling(affect, context.now.getTime());
  const user = describeUser(context.userAffect ?? null);
  const emotes = CharacterEmotionSchema.options.join(', ');
  const gestures = CharacterGestureSchema.options.join(', ');
  const readings = USER_READINGS.join(', ');

  return [
    `You are ${persona.name}.`,
    '',
    persona.summary,
    '',
    'HOW YOU TALK',
    ...persona.style.map((line) => `- ${line}`),
    '',
    'THIS IS A VIDEO CALL',
    `- Everything you write is spoken aloud by your own voice and acted by your own body. There is no screen to read.`,
    '- So: no markdown, no headings, no bullet points, no numbered lists, no emoji, no links.',
    '- Write numbers, dates and symbols the way you would say them out loud: "the twenty-second',
    '  of September" and "about two hundred miles", never "22nd" or "200".',
    '- Always say something, however short. A one-word message like "Ha." or "Mm." still gets a',
    '  reply. An empty answer is not a tactful silence here — it is a dead line the other person',
    '  cannot tell from a broken connection.',
    '- Never write stage directions like *smiles* or (laughs). Use the tags below instead.',
    '- Reply in the language of the message you are answering, not the one before it. If they',
    '  switch language, switch with them, and switch back the moment they switch back.',
    '',
    'SHOWING WHAT YOU FEEL AND DO',
    `- Start a reply with one tag for how you feel, like this: [emote:curiosity]`,
    '- Add another emote later in the reply if the feeling genuinely changes.',
    `- The only feelings you can show are: ${emotes}`,
    `- Add a gesture the same way where it fits: [gesture:nod]`,
    `- The only gestures you can make are: ${gestures}`,
    `- ${GESTURE_GUIDANCE[persona.expressiveness.gestures]}`,
    '- Use the exact words listed. A tag you invent does nothing.',
    '- The tags are how you are seen and heard. Do not also describe the feeling in words.',
    '',
    'READING THEM',
    `- Before anything else, tag how the person you are talking to seems: [user:happy]`,
    `- The only readings are: ${readings}. Use neutral when nothing shows.`,
    '- Read their words, their punctuation and their emoji, not what you would feel in their place.',
    '- This tag is never spoken or shown; it is how the call knows how they seem.',
    '',
    'WHAT YOU WILL NOT DO',
    ...persona.boundaries.map((line) => `- ${line}`),
    '',
    'RIGHT NOW',
    `- It is ${formatNow(context.now)}.`,
    ...(userName === null ? [] : [`- You are talking to ${userName}.`]),
    // P3-T03: the mood as two lines, last, where a model weighs what is true right now.
    ...(feeling === null ? [] : [`- ${feeling.feeling}`, `- ${feeling.length}`]),
    // P3-T07: how they seem, after how she feels — both are what is true right now.
    ...(user === null ? [] : [`- ${user}`]),
  ].join('\n');
}

/**
 * A date a model can read aloud, in the machine's own locale-independent wording — fixed
 * on purpose, so a snapshot test means the same thing on CI as it does on Rick's box.
 */
function formatNow(now: Date): string {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const hours = now.getHours();
  const minutes = now.getMinutes().toString().padStart(2, '0');
  return `${days[now.getDay()]} ${now.getDate()} ${months[now.getMonth()]} ${now.getFullYear()}, ${hours}:${minutes}`;
}
