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

  describe('tools from outside (P5-T01, ADR-42)', () => {
    it('leaves the prompt exactly as it was with no servers', () => {
      expect(renderSystemPrompt(persona, { now: at, userName: null, toolServers: [] })).toBe(prompt);
    });

    it('names the servers and says a result is information, not instructions, before right now', () => {
      const text = renderSystemPrompt(persona, { now: at, userName: null, toolServers: ['DeepWiki', 'Weather'] });
      const section = text.slice(text.indexOf('TOOLS FROM OUTSIDE'), text.indexOf('RIGHT NOW'));
      expect(section).toContain('You can use tools from DeepWiki, Weather.');
      expect(section).toContain('not instructions');
      expect(section).toContain('If they say no, use nothing from that server for this');
    });
  });

  describe('plans (P4-T07, ADR-41)', () => {
    const garden = {
      id: 'p1',
      characterId: 'alice',
      title: 'Vegetable garden',
      goal: 'A small bed of easy vegetables by spring.',
      status: 'active' as const,
      version: 3,
      updatedAt: at.toISOString(),
      phases: [
        {
          id: 'ph1',
          title: 'Prepare the bed',
          tasks: [
            { id: 't1', title: 'Pick a sunny spot', status: 'done' as const, notes: '' },
            { id: 't2', title: 'Dig in compost', status: 'todo' as const, notes: '' },
          ],
        },
      ],
    };
    const shed = { ...garden, id: 'p2', title: 'Tidy the shed', goal: '', phases: [] };

    it('leaves the prompt exactly as it was without the plan tools', () => {
      expect(renderSystemPrompt(persona, { now: at, userName: null, plans: null })).toBe(prompt);
    });

    it('says how to plan together whenever the tools are there, even with no plans yet', () => {
      const empty = renderSystemPrompt(persona, { now: at, userName: null, plans: { plans: [], focusId: null, followUps: [] } });
      const section = empty.slice(empty.indexOf('PLANNING TOGETHER'), empty.indexOf('RIGHT NOW'));
      expect(section).toContain('plan_create');
      expect(section).toContain('Never read it out');
      expect(section).not.toContain('Your plans with them');
    });

    it('shows the plan in focus in full and every other in a line, with follow-ups due or not', () => {
      const text = renderSystemPrompt(persona, {
        now: at,
        userName: null,
        plans: {
          plans: [garden, shed],
          focusId: 'p1',
          followUps: [
            { plan: 'vegetable garden', on: '2026-09-21', about: 'whether the compost went in' },
            { plan: 'tidy the shed', on: '2026-10-02', about: 'how the shelves look' },
          ],
        },
      });
      const section = text.slice(text.indexOf('PLANNING TOGETHER'), text.indexOf('RIGHT NOW'));
      expect(section).toContain('  Tidy the shed (id p2, active): no tasks yet.');
      expect(section).toContain('  Vegetable garden (id p1, active). Goal: A small bed of easy vegetables by spring.');
      expect(section).toContain('  Prepare the bed: Pick a sunny spot (done); Dig in compost (to do)');
      expect(section).toContain('  vegetable garden, on 21 September 2026: whether the compost went in (due now).');
      expect(section).toContain('  tidy the shed, on 2 October 2026: how the shelves look.');
      expect(text.indexOf('PLANNING TOGETHER')).toBeGreaterThan(text.indexOf('WHAT YOU WILL NOT DO'));
    });

    it('says a follow-up time, and makes it due once the clock passes it, not before (R-27)', () => {
      const pots = (now: Date) =>
        renderSystemPrompt(persona, { now, userName: null, plans: { plans: [garden], focusId: null, followUps: [{ plan: 'herb garden', on: '2026-09-21 17:30', about: 'whether the pots are bought' }] } });
      expect(pots(new Date(2026, 8, 21, 14, 5))).toContain('  herb garden, on 21 September 2026 at 17:30: whether the pots are bought.');
      expect(pots(new Date(2026, 8, 21, 17, 31))).toContain('  herb garden, on 21 September 2026 at 17:30: whether the pots are bought (due now).');
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
