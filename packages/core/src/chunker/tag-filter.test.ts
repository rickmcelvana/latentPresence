import { CharacterGestureSchema } from '@latentpresence/protocol';
import { describe, expect, it } from 'vitest';
import { TAG_SCAN_LIMIT, knownGestures } from './chunker';
import { TagFilter } from './tag-filter';

/** Feed a whole answer one delta at a time and return what a viewer would have seen. */
function stream(deltas: readonly string[]): string {
  const filter = new TagFilter();
  return deltas.map((delta) => filter.push(delta)).join('') + filter.flush();
}

describe('TagFilter', () => {
  it('removes a tag that arrives whole', () => {
    expect(stream(['[emote:joy] Hello there.'])).toBe('Hello there.');
  });

  it('removes a tag split across deltas, showing no fragment on the way', () => {
    const filter = new TagFilter();
    // The pilot's models emit tags in pieces; every one of these must be silent.
    expect(filter.push('[emo')).toBe('');
    expect(filter.push('te:jo')).toBe('');
    expect(filter.push('y] Hi')).toBe('Hi');
    expect(filter.flush()).toBe('');
  });

  it('splits one delta at a time to the character, and never leaks', () => {
    const answer = '[emote:curiosity] That is a good question. [gesture:shrug] I am not sure.';
    expect(stream([...answer])).toBe('That is a good question. I am not sure.');
  });

  it('keeps the words either side of a mid-reply tag, with one space', () => {
    expect(stream(['Hello [emote:joy] world'])).toBe('Hello world');
  });

  it('passes a bracket that is not a tag straight through', () => {
    expect(stream(['I read [1] and [emote:nonsense here.'])).toBe('I read [1] and [emote:nonsense here.');
  });

  it('gives back a partial tag the stream ended on rather than eating it', () => {
    // An answer that really ends "[emo" is an answer that ends "[emo".
    const filter = new TagFilter();
    expect(filter.push('Done. [emo')).toBe('Done. ');
    expect(filter.flush()).toBe('[emo');
  });

  it('releases an unclosed bracket once it is too long to be a tag', () => {
    const long = '['.concat('x'.repeat(TAG_SCAN_LIMIT + 5));
    expect(stream([long])).toBe(long);
  });

  it('holds back no more than the scan limit', () => {
    const filter = new TagFilter();
    filter.push(`[${'a'.repeat(TAG_SCAN_LIMIT - 2)}`);
    // Whatever is held must be releasable; the next character proves it cannot be a tag.
    expect(filter.push('b').length + filter.flush().length).toBeGreaterThan(0);
  });

  it('removes an unknown label, because it is still a well-formed tag', () => {
    // `known: null` is the chunker's verdict; the grammar still says "not speech".
    expect(stream(['[gesture:backflip] Watch this.'])).toBe('Watch this.');
  });
});

describe('the gesture vocabulary', () => {
  it('matches CharacterGestureSchema exactly', () => {
    // Without this, a ninth gesture would be reported `known: null` and P2-T03 would
    // have a clip nothing ever asks for.
    expect([...knownGestures].toSorted()).toEqual([...CharacterGestureSchema.options].toSorted());
  });
});
