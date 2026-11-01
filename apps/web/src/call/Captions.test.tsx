import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CAPTION_HOLD_MS } from '@latentpresence/core';
import type { ConversationEvent } from '@latentpresence/protocol';
import { Captions } from './Captions';
import { expectAccessible } from '../test/axe';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const T0 = 1_700_000_000_000;

/** A bus a test pushes events into, shaped like `ConversationMachine.subscribe`. */
function bus(): { subscribe: (listener: (event: ConversationEvent) => void) => () => void; emit: (event: ConversationEvent) => void } {
  const listeners = new Set<(event: ConversationEvent) => void>();
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: (event) => act(() => listeners.forEach((listener) => listener(event))),
  };
}

function base(ms: number): { sessionId: string; at: string } {
  return { sessionId: 's1', at: new Date(T0 + ms).toISOString() };
}

describe('Captions (P9-T01)', () => {
  it('shows her sentence with her name while it plays, and takes it down after the hold', () => {
    vi.useFakeTimers({ now: T0 });
    const events = bus();
    render(<Captions characterName="Alice" subscribe={events.subscribe} />);
    expect(screen.queryByTestId('captions')).toBeNull();

    events.emit({ ...base(0), type: 'assistant.sentence', index: 0, text: 'Hello there.', tags: [] });
    expect(screen.queryByTestId('captions')).toBeNull();
    events.emit({ ...base(0), type: 'assistant.audio.started', sentenceIndex: 0 });
    expect(screen.getByTestId('captions').textContent).toBe('AliceHello there.');
    // Not a live region: the transcript's log is the screen reader's.
    expect(screen.getByTestId('captions').getAttribute('aria-live')).toBeNull();

    events.emit({ ...base(0), type: 'assistant.audio.ended', sentenceIndex: 0 });
    act(() => vi.advanceTimersByTime(CAPTION_HOLD_MS - 1));
    expect(screen.queryByTestId('captions')).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByTestId('captions')).toBeNull();
  });

  it('labels their recognised words as theirs', () => {
    vi.useFakeTimers({ now: T0 });
    const events = bus();
    render(<Captions characterName="Alice" subscribe={events.subscribe} />);
    events.emit({ ...base(0), type: 'user.transcript', text: 'what time is it', isFinal: true, confidence: null });
    expect(screen.getByTestId('captions').textContent).toBe('Youwhat time is it');
  });

  it('is accessible while showing a caption', async () => {
    // Real timers: axe schedules its own work on them.
    const events = bus();
    const { container } = render(<Captions characterName="Alice" subscribe={events.subscribe} />);
    events.emit({ ...base(0), type: 'assistant.sentence', index: 0, text: 'Hello there.', tags: [] });
    events.emit({ ...base(0), type: 'assistant.audio.started', sentenceIndex: 0 });
    await expectAccessible(container);
  });
});
