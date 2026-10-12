import { describe, expect, it } from 'vitest';
import type { TranscriptLine } from '@latentpresence/core';
import type { PlanDocument } from '@latentpresence/protocol';
import type { CitationSource } from '../transcript/TranscriptPanel';
import { latestCitedSources, pickPlan, planToWhiteboard, sourcesToScreen } from './displays';

function plan(id: string, updatedAt: string, status: PlanDocument['status'] = 'active', phases: PlanDocument['phases'] = []): PlanDocument {
  return { id, characterId: 'c', title: `Plan ${id}`, goal: '', phases, status, version: 1, updatedAt };
}

describe('pickPlan', () => {
  const older = plan('a', '2026-10-01T00:00:00.000Z');
  const newer = plan('b', '2026-10-05T00:00:00.000Z');
  const archived = plan('c', '2026-10-09T00:00:00.000Z', 'archived');

  it('prefers the plan in focus', () => {
    expect(pickPlan([newer, older], 'a')?.id).toBe('a');
  });

  it('else takes the newest that is not archived', () => {
    expect(pickPlan([archived, older, newer], null)?.id).toBe('b');
    expect(pickPlan([older, newer], 'gone')?.id).toBe('b');
  });

  it('is null with no plans, or only archived ones', () => {
    expect(pickPlan([], null)).toBeNull();
    expect(pickPlan([archived], null)).toBeNull();
  });
});

describe('planToWhiteboard', () => {
  it('turns phases into headings and tasks into lines, done ones marked and dropped ones left out', () => {
    const board = planToWhiteboard(
      plan('a', '2026-10-01T00:00:00.000Z', 'active', [
        {
          id: 'p1',
          title: 'Prepare',
          tasks: [
            { id: 't1', title: 'Dig', status: 'done', notes: '' },
            { id: 't2', title: 'Buy seed', status: 'doing', notes: '' },
            { id: 't3', title: 'Build a fence', status: 'dropped', notes: '' },
          ],
        },
        { id: 'p2', title: 'Plant', tasks: [{ id: 't4', title: 'Sow', status: 'todo', notes: '' }] },
      ]),
    );
    expect(board).toEqual({
      title: 'Plan a',
      lines: [
        { text: 'Prepare', kind: 'heading', done: false },
        { text: 'Dig', kind: 'task', done: true },
        { text: 'Buy seed', kind: 'task', done: false },
        { text: 'Plant', kind: 'heading', done: false },
        { text: 'Sow', kind: 'task', done: false },
      ],
    });
  });
});

describe('sourcesToScreen', () => {
  it('is null with no sources', () => {
    expect(sourcesToScreen([])).toBeNull();
  });

  it('lists each source by title, where (the locator) and text', () => {
    const sources: CitationSource[] = [
      { title: 'Boiler manual', locator: 'p. 12', source: 'C:/manuals/boiler.pdf', text: 'Hold the button.' },
      { title: 'Example', locator: 'example.com', source: 'https://example.com/a', text: 'A page.' },
      { title: 'Notes', locator: null, source: 'notes.md', text: 'Plain.' },
    ];
    expect(sourcesToScreen(sources)).toEqual({
      heading: 'Sources',
      items: [
        { title: 'Boiler manual', where: 'p. 12', text: 'Hold the button.' },
        { title: 'Example', where: 'example.com', text: 'A page.' },
        { title: 'Notes', where: null, text: 'Plain.' },
      ],
    });
  });
});

const KNOWN: Readonly<Record<string, CitationSource>> = {
  c1: { title: 'One', locator: null, source: 's1', text: 't1' },
  c2: { title: 'Two', locator: null, source: 's2', text: 't2' },
};

function lookup(ref: string): CitationSource | undefined {
  return KNOWN[ref];
}

function reply(id: string, citations: string[]): TranscriptLine {
  return {
    kind: 'assistant',
    id,
    at: '2026-10-11T00:00:00.000Z',
    status: 'complete',
    text: 'x',
    heard: null,
    unsaid: '',
    firstTokenMs: null,
    firstAudioMs: null,
    citations,
  };
}

describe('latestCitedSources', () => {
  it('takes the latest answer that cited anything, skipping unknown refs', () => {
    const lines = [reply('a', ['c1']), reply('b', ['c2', 'nope']), reply('c', [])];
    expect(latestCitedSources(lines, lookup).map((source) => source.title)).toEqual(['Two']);
  });

  it('is empty when no answer cited anything', () => {
    expect(latestCitedSources([reply('a', [])], lookup)).toEqual([]);
    expect(latestCitedSources([], lookup)).toEqual([]);
  });
});
