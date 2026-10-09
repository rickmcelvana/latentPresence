import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptLine } from '@latentpresence/core';
import { TranscriptPanel } from './TranscriptPanel';

afterEach(cleanup);

const USER_LINE: TranscriptLine = { kind: 'user', id: 'u1', text: 'what time is it', at: '2026-09-14T15:04:00.000Z', via: 'text' };
const ASSISTANT_LINE: TranscriptLine = {
  kind: 'assistant',
  id: 'a1',
  at: '2026-09-14T15:04:01.000Z',
  status: 'complete',
  text: 'It is nearly three.',
  heard: null,
  unsaid: '',
  firstTokenMs: 412,
  firstAudioMs: 1893,
  citations: [],
};
const INTERRUPTED_LINE: TranscriptLine = {
  kind: 'assistant',
  id: 'a2',
  at: '2026-09-14T15:04:05.000Z',
  status: 'interrupted',
  text: 'Once upon a time there was a dragon.',
  heard: 'Once upon a time',
  unsaid: ' there was a dragon.',
  firstTokenMs: null,
  firstAudioMs: null,
  citations: [],
};
const NOTICE_LINE: TranscriptLine = { kind: 'notice', id: 'n1', at: '2026-09-14T15:04:10.000Z', text: 'The language model failed: 401 Unauthorized' };

describe('TranscriptPanel — lines', () => {
  it('renders a user and an assistant line with their names', () => {
    render(<TranscriptPanel characterName="Alice" lines={[USER_LINE, ASSISTANT_LINE]} onClear={() => {}} />);
    expect(screen.getByText('You')).toBeTruthy();
    expect(screen.getByText('Alice')).toBeTruthy();
    expect(screen.getByText('what time is it')).toBeTruthy();
    expect(screen.getByText('It is nearly three.')).toBeTruthy();
  });

  it('shows an interrupted line as heard text, an assistive-only "(not said)" marker, and the pill', () => {
    const { container } = render(<TranscriptPanel characterName="Alice" lines={[INTERRUPTED_LINE]} onClear={() => {}} />);
    expect(screen.getByText('interrupted')).toBeTruthy();
    expect(screen.getByText('(not said)')).toBeTruthy();
    expect(container.textContent).toContain('Once upon a time');
    expect(container.textContent).toContain('there was a dragon.');
  });

  it('says nothing about unsaid words when a stopped reply has none', () => {
    const stopped: TranscriptLine = { ...INTERRUPTED_LINE, id: 'a3', text: 'Half', heard: 'Half', unsaid: '' };
    render(<TranscriptPanel characterName="Alice" lines={[stopped]} onClear={() => {}} />);
    expect(screen.getByText('interrupted')).toBeTruthy();
    expect(screen.queryByText('(not said)')).toBeNull();
  });

  it('renders only the badges whose figure exists, formatting >= 1000 ms as seconds', () => {
    render(<TranscriptPanel characterName="Alice" lines={[ASSISTANT_LINE]} onClear={() => {}} />);
    expect(screen.getByText('first word 412 ms')).toBeTruthy();
    expect(screen.getByText('first audio 1.9 s')).toBeTruthy();
  });

  it('renders no badges when neither figure exists', () => {
    const { container } = render(<TranscriptPanel characterName="Alice" lines={[INTERRUPTED_LINE]} onClear={() => {}} />);
    expect(container.querySelector('.transcript-badges')).toBeNull();
  });

  it('renders a notice as a plain marked line', () => {
    render(<TranscriptPanel characterName="Alice" lines={[NOTICE_LINE]} onClear={() => {}} />);
    expect(screen.getByText('The language model failed: 401 Unauthorized')).toBeTruthy();
  });

  it('the log region is a polite log', () => {
    render(<TranscriptPanel characterName="Alice" lines={[USER_LINE]} onClear={() => {}} />);
    const log = screen.getByRole('log');
    expect(log.getAttribute('aria-live')).toBe('polite');
  });
});

const lookup = (ref: string) =>
  ref === 'c1'
    ? { title: 'Boiler manual', locator: 'p. 12', source: 'C:/docs/boiler.pdf', text: 'Open the bleed valve a quarter turn.' }
    : ref === 'c2'
      ? { title: 'Notes', locator: null, source: 'C:/docs/notes.md', text: 'The pump lives under the stairs.' }
      : undefined;

describe('TranscriptPanel — sources (P5-T04, ADR-45)', () => {
  const CITED: TranscriptLine = {
    ...ASSISTANT_LINE,
    id: 'a-cited',
    text: 'Bleed the radiator first. The pump is under the stairs.',
    citations: ['c1', 'c2'],
  };

  it('lists each citation numbered, with the page when there is one, and opens to the text and the path', () => {
    const { container } = render(<TranscriptPanel characterName="Alice" lines={[CITED]} onClear={() => {}} sources={lookup} />);
    expect(screen.getByText('Sources')).toBeTruthy();
    const first = screen.getByText('1. Boiler manual, p. 12');
    expect(first.tagName).toBe('SUMMARY');
    expect(screen.getByText('2. Notes').tagName).toBe('SUMMARY');
    const details = container.querySelectorAll('details');
    expect(details).toHaveLength(2);
    expect(details[0]?.open).toBe(false);
    fireEvent.click(first);
    expect(details[0]?.textContent).toContain('Open the bleed valve a quarter turn.');
    expect(details[0]?.querySelector('blockquote')?.textContent).toBe('Open the bleed valve a quarter turn.');
    expect(details[0]?.querySelector('code')?.textContent).toBe('C:/docs/boiler.pdf');
  });

  it('shows a ref she was not given as such, with nothing to open', () => {
    const made: TranscriptLine = { ...CITED, id: 'a-made', citations: ['c1', 'c999'] };
    const { container } = render(<TranscriptPanel characterName="Alice" lines={[made]} onClear={() => {}} sources={lookup} />);
    const unknown = screen.getByText('2. A source she was not given');
    expect(unknown.className).toContain('transcript-source-unknown');
    expect(unknown.querySelector('details')).toBeNull();
    expect(container.querySelectorAll('details')).toHaveLength(1);
  });

  it('with no sources lookup, every citation is one she was not given', () => {
    render(<TranscriptPanel characterName="Alice" lines={[CITED]} onClear={() => {}} />);
    expect(screen.getByText('1. A source she was not given')).toBeTruthy();
    expect(screen.getByText('2. A source she was not given')).toBeTruthy();
  });

  it('shows no Sources heading when nothing was cited', () => {
    render(<TranscriptPanel characterName="Alice" lines={[ASSISTANT_LINE]} onClear={() => {}} sources={lookup} />);
    expect(screen.queryByText('Sources')).toBeNull();
  });

  it('shows the sources of a streaming line as they arrive, and an interrupted line keeps them', () => {
    const streaming: TranscriptLine = { ...CITED, id: 'a-stream', status: 'streaming', citations: ['c1'] };
    const { rerender } = render(<TranscriptPanel characterName="Alice" lines={[streaming]} onClear={() => {}} sources={lookup} />);
    expect(screen.getByText('1. Boiler manual, p. 12')).toBeTruthy();
    const interrupted: TranscriptLine = { ...streaming, status: 'interrupted', heard: 'Bleed the radiator', unsaid: ' first.' };
    rerender(<TranscriptPanel characterName="Alice" lines={[interrupted]} onClear={() => {}} sources={lookup} />);
    expect(screen.getByText('1. Boiler manual, p. 12')).toBeTruthy();
  });
});

describe('TranscriptPanel — Clear', () => {
  it('calls onClear', () => {
    const onClear = vi.fn();
    render(<TranscriptPanel characterName="Alice" lines={[USER_LINE]} onClear={onClear} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});

describe('TranscriptPanel — Copy', () => {
  it("writes the note's exact text and confirms it", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<TranscriptPanel characterName="Alice" lines={[USER_LINE, INTERRUPTED_LINE, NOTICE_LINE]} onClear={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy transcript' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith(
      ['You: what time is it', 'Alice: Once upon a time [interrupted]', '[error] The language model failed: 401 Unauthorized'].join('\n'),
    );
    await waitFor(() => expect(screen.getByText('Copied')).toBeTruthy());
  });

  it('says so when the clipboard refuses', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.assign(navigator, { clipboard: { writeText } });
    render(<TranscriptPanel characterName="Alice" lines={[USER_LINE]} onClear={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy transcript' }));
    await waitFor(() => expect(screen.getByText('Could not copy to the clipboard.')).toBeTruthy());
  });
});
