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

  describe('her own notes (P4-T06, ADR-40)', () => {
    it('leaves the prompt as it was with no notes, or only empty ones', () => {
      expect(renderSystemPrompt(persona, { now: at, userName: null, notes: [] })).toBe(prompt);
      expect(renderSystemPrompt(persona, { now: at, userName: null, notes: [{ name: 'blank', content: '  ' }] })).toBe(prompt);
    });

    it('lists them in their own section, before right now', () => {
      const withNotes = renderSystemPrompt(persona, { now: at, userName: null, notes: [{ name: 'how_they_talk', content: 'Direct; no small talk.' }] });
      const section = withNotes.slice(withNotes.indexOf('YOUR OWN NOTES'), withNotes.indexOf('RIGHT NOW'));
      expect(section).toContain('- how they talk: Direct; no small talk.');
      expect(section).toContain('self_write_block');
    });
  });

  describe('memory (P4-T04b, ADR-38)', () => {
    const fact = {
      id: 'f1',
      characterId: 'alice',
      subject: 'user',
      predicate: 'sister_name',
      object: 'Priya',
      confidence: 0.9,
      validFrom: at.toISOString(),
      validTo: null,
      recordedAt: at.toISOString(),
      sourceEpisodeId: null,
      embedding: null,
    };
    const episode = {
      id: 'e1',
      sessionId: 'visit-1',
      characterId: 'alice',
      role: 'user' as const,
      text: 'The allotment flooded again',
      interrupted: false,
      at: new Date(at.getTime() - 3 * 86_400_000).toISOString(),
      embedding: null,
      affect: null,
    };

    it('leaves the prompt exactly as it was with nothing remembered', () => {
      expect(renderSystemPrompt(persona, { now: at, userName: null, memory: null })).toBe(prompt);
      expect(renderSystemPrompt(persona, { now: at, userName: null, memory: { facts: [], episodes: [] } })).toBe(prompt);
    });

    it('says what she knows and what was said before, ahead of right now', () => {
      const withMemory = renderSystemPrompt(persona, { now: at, userName: null, memory: { facts: [fact], episodes: [episode] } });
      const section = withMemory.slice(withMemory.indexOf('WHAT YOU REMEMBER ABOUT THEM'), withMemory.indexOf('RIGHT NOW'));
      expect(section).toContain('- user sister name Priya');
      expect(section).toContain('- 3 days ago, they said: "The allotment flooded again"');
      expect(withMemory.indexOf('WHAT YOU REMEMBER ABOUT THEM')).toBeGreaterThan(withMemory.indexOf('WHAT YOU WILL NOT DO'));
    });
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

  it('adds one line on how the user seems, last, only when it is sure enough (P3-T07)', () => {
    const seems = (label: 'sad' | 'neutral', confidence: number) => ({
      label,
      confidence,
      valence: -0.5,
      arousal: -0.3,
      readings: [{ channel: 'voice' as const, label, valence: -0.5, arousal: -0.3, confidence }],
      at: at.toISOString(),
    });
    expect(renderSystemPrompt(persona, { now: at, userAffect: null })).toBe(prompt);
    expect(renderSystemPrompt(persona, { now: at, userAffect: seems('sad', 0.2) })).toBe(prompt);
    expect(renderSystemPrompt(persona, { now: at, userAffect: seems('neutral', 0.9) })).toBe(prompt);
    const told = renderSystemPrompt(persona, { now: at, userAffect: seems('sad', 0.6) });
    expect(told.slice(prompt.length)).toBe('\n- They seem down (from how they sound). Let it shape how you answer; do not point it out unless they do.');
  });

  it('changes what it says about gestures with the expressiveness level', () => {
    const often: Persona = { ...persona, expressiveness: { gestures: 'often' } };
    expect(renderSystemPrompt(often, { now: at, userName: null })).not.toBe(prompt);
  });
});
