import alice from '../../../../personas/alice.persona.json' with { type: 'json' };
import { AffectStateSchema, CharacterEmotionSchema, CharacterGestureSchema, PersonaSchema, type Persona } from '@latentpresence/protocol';
import { describe, expect, it } from 'vitest';
import { initialAffect } from '../affect/engine';
import { SentenceChunker } from '../chunker';
import { renderSystemPrompt } from './prompt';

const persona = PersonaSchema.parse(alice);
const at = new Date(2026, 8, 21, 14, 5);

describe('the default persona file', () => {
  it('parses', () => {
    // The file ships as content, so nothing else typechecks it.
    expect(persona.name).toBe('Alice');
  });

  it('asks for a voice the TTS surface actually allows', () => {
    // Kokoro degrades past ~1.25 while still hitting the duration (SURFACE, D-13).
    expect(persona.voice.speed).toBeLessThanOrEqual(1.25);
    expect(persona.voice.speed).toBeGreaterThanOrEqual(0.75);
  });

  it('has boundaries', () => {
    expect(persona.boundaries.length).toBeGreaterThan(0);
  });
});

describe('PersonaSchema', () => {
  it('rejects a file with no version', () => {
    const { version: _drop, ...rest } = persona;
    expect(PersonaSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects a future version rather than reading it as v1', () => {
    expect(PersonaSchema.safeParse({ ...persona, version: 2 }).success).toBe(false);
  });

  it('rejects an empty style list', () => {
    expect(PersonaSchema.safeParse({ ...persona, style: [] }).success).toBe(false);
  });

  it('rejects a persona with no boundaries', () => {
    expect(PersonaSchema.safeParse({ ...persona, boundaries: [] }).success).toBe(false);
  });

  it('rejects a speed the voice cannot hold', () => {
    expect(PersonaSchema.safeParse({ ...persona, voice: { voiceId: 'af_heart', speed: 2 } }).success).toBe(false);
  });

  it('rejects an unknown expressiveness level', () => {
    expect(PersonaSchema.safeParse({ ...persona, expressiveness: { gestures: 'wild' } }).success).toBe(false);
  });
});

describe('renderSystemPrompt', () => {
  const prompt = renderSystemPrompt(persona, { now: at, userName: null });

  it('renders a stable snapshot', () => {
    expect(prompt).toMatchSnapshot();
  });

  it('lists every emote and every gesture the model may use', () => {
    // A label the prompt omits is a label the avatar can play and never will.
    for (const label of CharacterEmotionSchema.options) expect(prompt).toContain(label);
    for (const label of CharacterGestureSchema.options) expect(prompt).toContain(label);
  });

  it('says what day it is, in words a voice can read', () => {
    expect(prompt).toContain('Monday 21 September 2026, 14:05');
  });

  it('names the user when it knows them, and does not invent one when it does not', () => {
    expect(prompt).not.toContain('You are talking to');
    expect(renderSystemPrompt(persona, { now: at, userName: 'Rick' })).toContain('You are talking to Rick');
  });

  it('forbids the two things the pilot actually caught', () => {
    // A model answering in Chinese, and a model writing *smiles* instead of tagging.
    expect(prompt).toContain('Reply in the language');
    expect(prompt).toContain('*smiles*');
  });

  it('carries an example of each tag in the exact grammar the chunker parses', () => {
    // The prompt teaches by example, so its examples must be the real syntax.
    const chunker = new SentenceChunker();
    const chunks = [...chunker.push('[emote:curiosity] Hello. [gesture:nod] Yes.'), ...chunker.flush()];
    const tags = chunks.flatMap((chunk) => chunk.tags);
    expect(tags.map((tag) => tag.known)).toEqual(['curiosity', 'nod']);
    expect(prompt).toContain('[emote:curiosity]');
    expect(prompt).toContain('[gesture:nod]');
  });

  it('says nothing about mood without an affect state, exactly as before P3-T03', () => {
    expect(renderSystemPrompt(persona, { now: at, userName: null, affect: null })).toBe(prompt);
    expect(renderSystemPrompt(persona, { now: at })).toBe(prompt);
  });

  it('ends with two lines on how she feels and how much to say when it has one', () => {
    const rest = initialAffect('alice', at.getTime());
    const low = AffectStateSchema.parse({ ...rest, mood: { pleasure: -0.6, arousal: -0.4, dominance: -0.3 }, energy: 0.2 });
    const calm = renderSystemPrompt(persona, { now: at, userName: null, affect: rest });
    const sad = renderSystemPrompt(persona, { now: at, userName: null, affect: low });
    expect(calm.startsWith(prompt)).toBe(true);
    expect(calm.slice(prompt.length).split('\n').filter(Boolean)).toHaveLength(2);
    expect(sad.slice(prompt.length)).toContain('unhappy');
    expect(sad.slice(prompt.length)).toContain('a sentence or two');
    expect(sad).not.toBe(calm);
  });

  it('changes what it says about gestures with the expressiveness level', () => {
    const often: Persona = { ...persona, expressiveness: { gestures: 'often' } };
    expect(renderSystemPrompt(often, { now: at, userName: null })).not.toBe(prompt);
  });
});
