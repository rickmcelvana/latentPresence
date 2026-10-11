import { describe, expect, it } from 'vitest';
import { citedSources } from './sources';

describe('citedSources (P5-T06, ADR-47)', () => {
  it('lists every search hit with a ref, as the page gets it from mcpTools', () => {
    const searched = {
      from: 'Web',
      result: {
        cite: 'End each sentence…',
        found: [
          { ref: 'w1a2b3c', title: 'Halifax weather', url: 'https://weather.example/halifax', site: 'weather.example', snippet: 'Cloudy, 12 C.', published: null },
          { ref: 'not-a-ref', title: 'x', url: 'https://x.example', site: '', snippet: '' },
          { ref: 'w0f0f0f', title: '', url: 'javascript:alert(1)', site: '', snippet: '' },
        ],
      },
    };
    expect(citedSources(searched)).toEqual([
      { ref: 'w1a2b3c', title: 'Halifax weather', locator: 'weather.example', source: 'https://weather.example/halifax', text: 'Cloudy, 12 C.' },
    ]);
  });

  it('lists a page read, its text cut to what is worth opening', () => {
    const page = { from: 'Web', result: { ref: 'wabcdef', title: '', url: 'https://f.example/hourly', site: 'f.example', lines: '1–80 of 400', text: 'x'.repeat(1000), more: null } };
    const [cited] = citedSources(page);
    expect(cited?.title).toBe('https://f.example/hourly');
    expect(cited?.text).toHaveLength(601);
  });

  it('gives none for an error, a file, or anything else', () => {
    expect(citedSources({ error: 'Web said: no' })).toEqual([]);
    expect(citedSources({ from: 'Files', result: 'Basil, thyme.' })).toEqual([]);
    expect(citedSources(null)).toEqual([]);
    expect(citedSources([1, 2])).toEqual([]);
  });
});
