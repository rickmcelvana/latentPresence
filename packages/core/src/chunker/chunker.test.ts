import { describe, expect, it } from 'vitest';
import { CharacterEmotionSchema } from '@latentpresence/protocol';
import { chunkText, knownEmotions, selfSpacingTerminators, terminators, SentenceChunker } from './chunker';

/** One row of the splitting table: text in, the spoken chunks it must become. */
interface Row {
  readonly name: string;
  readonly input: string;
  readonly chunks: readonly string[];
}

/**
 * The forty tricky inputs the plan asks for (P1-T04), each named for the thing it would
 * break. A row is a claim about what the user hears, so every expectation is the chunk
 * text with tags already removed.
 */
const rows: readonly Row[] = [
  // Plain sentence splitting.
  { name: 'one sentence', input: 'Hello there.', chunks: ['Hello there.'] },
  { name: 'two sentences', input: 'Hello there. How are you?', chunks: ['Hello there.', 'How are you?'] },
  { name: 'exclamation', input: 'Watch out! It is falling.', chunks: ['Watch out!', 'It is falling.'] },
  { name: 'question then statement', input: 'Ready? Then we go.', chunks: ['Ready?', 'Then we go.'] },
  { name: 'no terminator at all', input: 'just a fragment', chunks: ['just a fragment'] },
  { name: 'terminator run', input: 'Really?! I had no idea.', chunks: ['Really?!', 'I had no idea.'] },
  { name: 'closing quote joins its sentence', input: 'He said "go." Then he left.', chunks: ['He said "go."', 'Then he left.'] },
  { name: 'closing paren joins its sentence', input: '(It was late.) We went home.', chunks: ['(It was late.)', 'We went home.'] },

  // Abbreviations and initials.
  { name: 'title abbreviation', input: 'Dr. Smith is here.', chunks: ['Dr. Smith is here.'] },
  { name: 'mrs', input: 'Mrs. Patel called back.', chunks: ['Mrs. Patel called back.'] },
  { name: 'etc mid sentence', input: 'Bring tea, cake, etc. and a book.', chunks: ['Bring tea, cake, etc. and a book.'] },
  { name: 'e.g. is initials', input: 'Use a fruit, e.g. an apple, here.', chunks: ['Use a fruit, e.g. an apple, here.'] },
  { name: 'i.e. is initials', input: 'The first one, i.e. the red one, wins.', chunks: ['The first one, i.e. the red one, wins.'] },
  { name: 'three initials', input: 'J. R. R. Tolkien wrote it.', chunks: ['J. R. R. Tolkien wrote it.'] },
  { name: 'country initialism', input: 'The U.S. economy grew.', chunks: ['The U.S. economy grew.'] },
  { name: 'abbreviation then real end', input: 'Ask Dr. Smith. Then leave.', chunks: ['Ask Dr. Smith.', 'Then leave.'] },
  { name: 'vs', input: 'It is cats vs. dogs today.', chunks: ['It is cats vs. dogs today.'] },
  { name: 'company suffix', input: 'Acme Inc. filed the papers.', chunks: ['Acme Inc. filed the papers.'] },

  // Numbers.
  { name: 'decimal', input: 'Pi is 3.14 roughly.', chunks: ['Pi is 3.14 roughly.'] },
  { name: 'money', input: 'It cost $1,000.50 in total.', chunks: ['It cost $1,000.50 in total.'] },
  { name: 'version string', input: 'Install v2.0.1 now.', chunks: ['Install v2.0.1 now.'] },
  { name: 'numbered list marker', input: '1. First thing 2. Second thing', chunks: ['1. First thing 2. Second thing'] },
  { name: 'decimal then sentence end', input: 'Pi is 3.14. That is enough.', chunks: ['Pi is 3.14.', 'That is enough.'] },

  // URLs, paths, code.
  { name: 'domain', input: 'Go to example.com for more.', chunks: ['Go to example.com for more.'] },
  { name: 'url then sentence end', input: 'See example.com. It explains everything.', chunks: ['See example.com.', 'It explains everything.'] },
  { name: 'filename', input: 'Open config.json and edit it.', chunks: ['Open config.json and edit it.'] },
  { name: 'inline code span', input: 'Call `foo.bar()` when ready.', chunks: ['Call `foo.bar()` when ready.'] },
  { name: 'code span holds a terminator', input: 'Run `a.b. c` then stop.', chunks: ['Run `a.b. c` then stop.'] },
  { name: 'fenced block is one chunk', input: '```\nlet a = 1. let b = 2.\n```\nDone.', chunks: ['```\nlet a = 1. let b = 2.\n```', 'Done.'] },

  // Emoji and non-Latin scripts.
  { name: 'emoji mid sentence', input: 'That is great \u{1F600} really.', chunks: ['That is great \u{1F600} really.'] },
  { name: 'emoji before terminator', input: 'Nice \u{1F389}. Well done.', chunks: ['Nice \u{1F389}.', 'Well done.'] },
  { name: 'japanese full stop', input: 'こんにちは。元気ですか。', chunks: ['こんにちは。', '元気ですか。'] },

  // Whitespace normalisation.
  { name: 'newlines become spaces', input: 'First line.\nSecond line.', chunks: ['First line.', 'Second line.'] },
  { name: 'runs of spaces collapse', input: 'Too    many     spaces.', chunks: ['Too many spaces.'] },
  { name: 'leading whitespace is dropped', input: '   Leading space here.', chunks: ['Leading space here.'] },
  { name: 'trailing whitespace is dropped', input: 'Trailing space here.   ', chunks: ['Trailing space here.'] },
  { name: 'empty input yields nothing', input: '', chunks: [] },
  { name: 'whitespace only yields nothing', input: '   \n  ', chunks: [] },

  // Tags are removed from what is spoken.
  { name: 'emote tag is stripped', input: 'I am glad [emote:joy] to hear it.', chunks: ['I am glad to hear it.'] },
  { name: 'gesture tag is stripped', input: 'Who knows [gesture:shrug] really.', chunks: ['Who knows really.'] },
  { name: 'tag between sentences', input: 'Hello. [emote:joy] Goodbye.', chunks: ['Hello.', 'Goodbye.'] },
  { name: 'unknown tag kind stays literal', input: 'See [note:this] here.', chunks: ['See [note:this] here.'] },
  { name: 'bare bracket stays literal', input: 'An [ unclosed bracket stays.', chunks: ['An [ unclosed bracket stays.'] },
  { name: 'tag inside code is literal', input: 'Type `[emote:joy]` exactly.', chunks: ['Type `[emote:joy]` exactly.'] },
];

describe('chunkText', () => {
  it.each(rows)('$name', ({ input, chunks }) => {
    expect(chunkText(input).map((chunk) => chunk.text)).toEqual(chunks);
  });

  it('covers at least the forty tricky inputs the plan asks for', () => {
    expect(rows.length).toBeGreaterThanOrEqual(40);
  });

  it('numbers chunks from zero, monotonically', () => {
    const chunks = chunkText('One. Two. Three.');
    expect(chunks.map((chunk) => chunk.index)).toEqual([0, 1, 2]);
  });

  it('never emits an empty or whitespace-only chunk', () => {
    for (const row of rows) {
      for (const chunk of chunkText(row.input)) {
        expect(chunk.text.trim()).not.toBe('');
      }
    }
  });
});

describe('SentenceChunker tags', () => {
  it('reports the offset into the spoken text, not the raw text', () => {
    const [chunk] = chunkText('I am glad [emote:joy] to hear it.');
    expect(chunk?.text).toBe('I am glad to hear it.');
    // `I am glad ` is ten characters; the tag sat exactly there.
    expect(chunk?.tags).toEqual([{ kind: 'emote', value: 'joy', known: 'joy', offset: 10 }]);
  });

  it('marks a known emotion and leaves an invented one unknown', () => {
    const [chunk] = chunkText('Well [emote:joy] and [emote:banana] then.');
    expect(chunk?.tags.map((tag) => tag.known)).toEqual(['joy', null]);
  });

  it('never marks a gesture as a known emotion', () => {
    const [chunk] = chunkText('Who knows [gesture:shrug] really.');
    expect(chunk?.tags).toEqual([{ kind: 'gesture', value: 'shrug', known: null, offset: 10 }]);
  });

  it('attaches a tag between sentences to the sentence that follows it', () => {
    const chunks = chunkText('Hello. [emote:joy] Goodbye.');
    expect(chunks[0]?.tags).toEqual([]);
    expect(chunks[1]?.tags).toEqual([{ kind: 'emote', value: 'joy', known: 'joy', offset: 0 }]);
  });

  it('keeps a tag that arrives after the last spoken character', () => {
    const chunker = new SentenceChunker();
    const chunks = [...chunker.push('Nice to meet you! [gesture:wave]'), ...chunker.flush()];
    expect(chunks.map((chunk) => chunk.text)).toEqual(['Nice to meet you!']);
    // Structurally this is the same as a tag between two sentences — it belongs to what
    // follows. Nothing follows, so it is trailing rather than attached to `you!`.
    expect(chunks[0]?.tags).toEqual([]);
    expect(chunker.trailingTags).toEqual([
      { kind: 'gesture', value: 'wave', known: null, offset: 0 },
    ]);
  });

  it('keeps a tag that has no chunk at all to ride out on', () => {
    const chunker = new SentenceChunker();
    const chunks = [...chunker.push('[gesture:wave]'), ...chunker.flush()];
    expect(chunks).toEqual([]);
    expect(chunker.trailingTags).toEqual([
      { kind: 'gesture', value: 'wave', known: null, offset: 0 },
    ]);
  });

  it('leaves no double space where a tag was lifted out', () => {
    for (const input of ['a [emote:joy] b', 'a [emote:joy]b', 'a[emote:joy] b']) {
      expect(chunkText(input)[0]?.text).not.toMatch(/ {2}/);
    }
  });
});

/** Feed one character at a time — the worst case the real token stream can produce. */
const perCharacter = (text: string): string[] => {
  const chunker = new SentenceChunker();
  const out: string[] = [];
  for (const ch of text) out.push(...chunker.push(ch).map((chunk) => chunk.text));
  out.push(...chunker.flush().map((chunk) => chunk.text));
  return out;
};

describe('SentenceChunker streaming', () => {
  it('gives the same answer per character as in one push, for every table row', () => {
    for (const row of rows) {
      expect(perCharacter(row.input)).toEqual([...row.chunks]);
    }
  });

  it('holds a sentence back until something confirms the terminator', () => {
    const chunker = new SentenceChunker();
    // `Pi is 3.` could still become `3.14`, so nothing may be emitted yet.
    expect(chunker.push('Pi is 3.')).toEqual([]);
    expect(chunker.push('14 is close.')).toEqual([]);
    expect(chunker.flush().map((chunk) => chunk.text)).toEqual(['Pi is 3.14 is close.']);
  });

  it('emits the first sentence before the rest of the turn arrives', () => {
    const chunker = new SentenceChunker();
    expect(chunker.push('Hello there. ').map((chunk) => chunk.text)).toEqual(['Hello there.']);
  });

  it('reassembles a tag split across three pushes', () => {
    const chunker = new SentenceChunker();
    chunker.push('Glad [emo');
    chunker.push('te:jo');
    chunker.push('y] to hear it.');
    const chunks = chunker.flush();
    expect(chunks[0]?.text).toBe('Glad to hear it.');
    expect(chunks[0]?.tags).toEqual([{ kind: 'emote', value: 'joy', known: 'joy', offset: 5 }]);
  });

  it('reassembles a fence split across pushes without splitting inside it', () => {
    const chunker = new SentenceChunker();
    const out = [
      ...chunker.push('``'),
      ...chunker.push('`\nlet a = 1. let b = 2.\n``'),
      ...chunker.push('`\nDone.'),
      ...chunker.flush(),
    ];
    expect(out.map((chunk) => chunk.text)).toEqual([
      '```\nlet a = 1. let b = 2.\n```',
      'Done.',
    ]);
  });

  it('releases a literal bracket that never closes rather than buffering forever', () => {
    const chunker = new SentenceChunker();
    chunker.push('An [');
    chunker.push('x'.repeat(60));
    expect(chunker.flush()[0]?.text).toBe(`An [${'x'.repeat(60)}`);
  });
});

describe('SentenceChunker long sentences', () => {
  it('breaks a run-on sentence at a clause mark before the limit', () => {
    const input = `${'a'.repeat(80)}, ${'b'.repeat(80)} and more text after that.`;
    const chunks = chunkText(input, { maxChars: 100 });
    expect(chunks[0]?.text).toBe(`${'a'.repeat(80)},`);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('breaks at a space when there is no clause mark', () => {
    const input = `${'a'.repeat(60)} ${'b'.repeat(60)} ${'c'.repeat(20)}`;
    const chunks = chunkText(input, { maxChars: 100 });
    expect(chunks[0]?.text).toBe('a'.repeat(60));
  });

  it('hard-splits a single unbroken word rather than buffering the turn', () => {
    const chunks = chunkText('z'.repeat(250), { maxChars: 100 });
    expect(chunks[0]?.text).toHaveLength(100);
    expect(chunks.map((chunk) => chunk.text).join('')).toBe('z'.repeat(250));
  });

  it('never hard-splits an emoji in half', () => {
    // 50 two-unit emoji with no space anywhere: every cut lands on a pair boundary.
    const chunks = chunkText('\u{1F600}'.repeat(50), { maxChars: 21 });
    for (const chunk of chunks) {
      expect(chunk.text).not.toMatch(/[\uD800-\uDBFF]$/);
      expect(chunk.text).not.toMatch(/^[\uDC00-\uDFFF]/);
    }
    expect(chunks.map((chunk) => chunk.text).join('')).toBe('\u{1F600}'.repeat(50));
  });

  it('does not split a sentence that is under the limit', () => {
    const input = `${'a'.repeat(90)} and more.`;
    expect(chunkText(input, { maxChars: 200 })).toHaveLength(1);
  });
});

describe('SentenceChunker constants', () => {
  it('knows exactly the emotions the protocol defines', () => {
    // The chunker keeps its own Set so the hot path is a lookup rather than a zod parse.
    // That duplication is only safe while this test holds: add a thirteenth
    // `CharacterEmotion` and, without it, every tag naming it would be reported
    // `known: null` and the avatar would silently lose an expression it can play.
    expect([...knownEmotions].toSorted()).toEqual(CharacterEmotionSchema.options.toSorted());
  });

  it('treats every self-spacing mark as a terminator', () => {
    // A CJK mark listed only as self-spacing would never be recorded as a candidate,
    // so the rule that exists to split Japanese would never fire at all.
    for (const mark of selfSpacingTerminators) {
      expect(terminators.has(mark)).toBe(true);
    }
  });
});
