import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY, loadSettings } from './settings';
import { isWelcomed } from './welcomed';

function storageOf(document: unknown): Pick<Storage, 'getItem'> {
  return { getItem: (key) => (key === SETTINGS_STORAGE_KEY && document !== undefined ? (typeof document === 'string' ? document : JSON.stringify(document)) : null) };
}

const chosen = { endpoint: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', modelId: 'llama3', temperature: null };
const { welcomed: _welcomed, ...beforeT02 } = DEFAULT_SETTINGS;

describe('isWelcomed (P8-T02)', () => {
  const documents: [string, unknown][] = [
    ['nothing stored', undefined],
    ['corrupt JSON', '{not json'],
    ['defaults', DEFAULT_SETTINGS],
    ['welcomed', { ...DEFAULT_SETTINGS, welcomed: true }],
    ['midway: a model chosen, not welcomed', { ...DEFAULT_SETTINGS, llm: chosen, welcomed: false }],
    ['before the wizard, no model', beforeT02],
    ['before the wizard, an endpoint but no model', { ...beforeT02, llm: { ...chosen, modelId: null } }],
    ['before the wizard, a model', { ...beforeT02, llm: chosen }],
  ];

  it.each(documents)('agrees with loadSettings: %s', (_name, document) => {
    expect(isWelcomed(storageOf(document))).toBe(loadSettings(storageOf(document)).welcomed);
  });

  it('is true only for the last two kinds of finished document', () => {
    expect(isWelcomed(storageOf({ ...DEFAULT_SETTINGS, welcomed: true }))).toBe(true);
    expect(isWelcomed(storageOf({ ...beforeT02, llm: chosen }))).toBe(true);
    expect(isWelcomed(storageOf(DEFAULT_SETTINGS))).toBe(false);
  });

  it('is false rather than throwing when storage does', () => {
    expect(isWelcomed({ getItem: () => { throw new Error('blocked'); } })).toBe(false);
  });
});
