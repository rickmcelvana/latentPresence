import { describe, expect, it } from 'vitest';
import { extractionMessages, parseExtraction } from './extract';

describe('parseExtraction', () => {
  it('reads the JSON through a code fence and prose around it', () => {
    const reply = 'Here you go:\n```json\n{"facts":[{"subject":"user","predicate":"lives_in","object":"Halifax","confidence":0.9,"validFrom":null,"replaces":null}],"ended":["f2"]}\n```';
    const parsed = parseExtraction(reply);
    expect(parsed.facts).toEqual([{ subject: 'user', predicate: 'lives_in', object: 'Halifax', confidence: 0.9, validFrom: null, replaces: null }]);
    expect(parsed.ended).toEqual(['f2']);
    expect(parsed.dropped).toBe(0);
  });

  it('drops entries that do not fit, one by one, and keeps the rest', () => {
    const parsed = parseExtraction('{"facts":[{"subject":"user"},{"subject":"user","predicate":"age","object":34},{"subject":"user","predicate":"likes","object":""}]}');
    expect(parsed.facts).toEqual([expect.objectContaining({ predicate: 'age', object: '34', confidence: 0.6 })]);
    expect(parsed.dropped).toBe(2);
  });

  it('normalises dates the model gives, and refuses words', () => {
    const parsed = parseExtraction('{"facts":[{"subject":"user","predicate":"lives_in","object":"Halifax","validFrom":"2026-08"},{"subject":"user","predicate":"job","object":"nurse","validFrom":"last month"}]}');
    expect(parsed.facts.map((fact) => fact.validFrom)).toEqual(['2026-08-01T00:00:00.000Z', null]);
  });

  it('reads nothing — rather than guessing — from a reply whose start was cut off', () => {
    // What glm-5.2:cloud sent through Ollama with reasoning on (2026-09-28, ADR-37).
    expect(parseExtraction('facts":[{"subject":"user","predicate":"name","object":"Jordan"}]}')).toEqual({ facts: [], ended: [], dropped: null });
    expect(parseExtraction('')).toEqual({ facts: [], ended: [], dropped: null });
  });

  it('is not fooled by braces inside strings', () => {
    const parsed = parseExtraction('{"facts":[{"subject":"user","predicate":"likes","object":"the {curly} band"}]} trailing }');
    expect(parsed.facts.map((fact) => fact.object)).toEqual(['the {curly} band']);
  });
});

describe('extractionMessages', () => {
  it('shows the model the exchange, its date and the known facts with their ids', () => {
    const [system, user] = extractionMessages(
      { user: ['I moved to Halifax.'], assistant: 'Oh, how exciting!', at: '2026-09-24T19:00:00.000Z' },
      [{ id: 'f1', characterId: 'alice', subject: 'user', predicate: 'lives_in', object: 'Toronto', confidence: 0.9, validFrom: '2026-09-01T00:00:00Z', validTo: null, recordedAt: '2026-09-01T00:00:00Z', sourceEpisodeId: null, embedding: null }],
    );
    expect(system?.role).toBe('system');
    expect(user?.content).toContain('Exchange date: 2026-09-24');
    expect(user?.content).toContain('f1: user lives_in Toronto');
    expect(user?.content).toContain('Person: I moved to Halifax.');
    expect(user?.content).toContain('Companion: Oh, how exciting!');
  });
});
