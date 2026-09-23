import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationMachine } from '@latentpresence/core';
import type { ConversationEvent, ConversationState } from '@latentpresence/protocol';
import { FakeAvatarRenderer } from '@latentpresence/avatar';
import { ModelConsent } from '@latentpresence/ml-web/consent';
import { AVATAR_DESCRIPTOR } from './character-asset';
import { CallStage } from './CallStage';

afterEach(cleanup);

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  };
}

function machine(): ConversationMachine {
  const built = new ConversationMachine({ sessionId: 'chat', characterId: 'alice' });
  built.start();
  return built;
}

// jsdom has no Blob URL registry at all (`typeof URL.createObjectURL === 'undefined'`), so
// the module-level global has to be stubbed for `CallStage`'s blob URL to exist.
beforeEach(() => {
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:test-character'),
    revokeObjectURL: vi.fn(),
  });
});

describe('CallStage — consent gates the fetch', () => {
  it('fetches nothing before consent is granted', async () => {
    const consent = new ModelConsent(memoryStorage());
    const fetchModel = vi.fn(async () => new Uint8Array([1, 2, 3]));
    render(
      <CallStage
        voice={null}
        consent={consent}
        createRenderer={() => new FakeAvatarRenderer()}
        fetchModel={fetchModel}
        machine={machine()}
      />,
    );
    await settle();

    expect(fetchModel).not.toHaveBeenCalled();
    expect(screen.getByText('This will download the character')).toBeTruthy();
  });

  it('agreeing grants the descriptor and loads a blob URL into the renderer', async () => {
    const consent = new ModelConsent(memoryStorage());
    const fetchModel = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const renderer = new FakeAvatarRenderer();
    render(
      <CallStage voice={null} consent={consent} createRenderer={() => renderer} fetchModel={fetchModel} machine={machine()} />,
    );
    await settle();

    fireEvent.click(screen.getByRole('button', { name: 'Show the character' }));
    await waitFor(() => expect(fetchModel).toHaveBeenCalledTimes(1));
    await settle();

    expect(consent.has([AVATAR_DESCRIPTOR])).toBe(true);
    expect(renderer.character?.url).toBe('blob:test-character');
  });

  it('a previously granted descriptor loads without asking', async () => {
    const consent = new ModelConsent(memoryStorage());
    consent.grant([AVATAR_DESCRIPTOR]);
    const fetchModel = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const renderer = new FakeAvatarRenderer();
    render(
      <CallStage voice={null} consent={consent} createRenderer={() => renderer} fetchModel={fetchModel} machine={machine()} />,
    );

    expect(screen.queryByText('This will download the character')).toBeNull();
    await waitFor(() => expect(fetchModel).toHaveBeenCalledTimes(1));
    await settle();
    expect(renderer.character?.url).toBe('blob:test-character');
  });

  it('"Not now" leaves the stage empty with a button, and fetches nothing', async () => {
    const consent = new ModelConsent(memoryStorage());
    const fetchModel = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const renderer = new FakeAvatarRenderer();
    render(
      <CallStage voice={null} consent={consent} createRenderer={() => renderer} fetchModel={fetchModel} machine={machine()} />,
    );
    await settle();

    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    await settle();

    expect(fetchModel).not.toHaveBeenCalled();
    expect(renderer.character).toBeNull();
    expect(screen.getByRole('button', { name: 'Show the character' })).toBeTruthy();
  });
});

/** A fake with the two VRM-only clip methods, recording what it is asked. */
class ClipRenderer extends FakeAvatarRenderer {
  readonly loaded: string[] = [];
  readonly played: { id: string; crossfadeMs: number }[] = [];
  loadClip(id: string, _url: string): Promise<void> {
    this.loaded.push(id);
    return Promise.resolve();
  }
  override playClip(id: string, options: { loop: boolean; crossfadeMs: number; weight: number }): Promise<void> {
    this.played.push({ id, crossfadeMs: options.crossfadeMs });
    return Promise.resolve();
  }
}

/** Just enough machine to move the state by hand. */
function scriptedMachine() {
  let state: ConversationState = 'listening';
  const listeners = new Set<(event: ConversationEvent) => void>();
  return {
    machine: {
      getState: () => state,
      subscribe: (listener: (event: ConversationEvent) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as unknown as ConversationMachine,
    to(next: ConversationState) {
      const from = state;
      state = next;
      for (const listener of listeners) listener({ type: 'state.changed', from, to: next } as unknown as ConversationEvent);
    },
  };
}

describe('CallStage — base clips follow the conversation (P2-T03)', () => {
  it('loads both clips after the character, starts the idle, and crossfades only on a real change', async () => {
    const consent = new ModelConsent(memoryStorage());
    consent.grant([AVATAR_DESCRIPTOR]);
    const renderer = new ClipRenderer();
    const scripted = scriptedMachine();
    render(
      <CallStage
        voice={null}
        consent={consent}
        createRenderer={() => renderer}
        fetchModel={async () => new Uint8Array([1])}
        machine={scripted.machine}
      />,
    );
    await waitFor(() => expect(renderer.played.length).toBe(1));

    expect(renderer.loaded.toSorted()).toEqual(['idle', 'talk']);
    expect(renderer.played[0]).toEqual({ id: 'idle', crossfadeMs: 0 });

    scripted.to('thinking');
    scripted.to('speaking');
    scripted.to('listening');
    // thinking is idle too, so it asks for nothing: a second `idle` would restart the loop.
    expect(renderer.played.map((play) => play.id)).toEqual(['idle', 'talk', 'idle']);
    expect(renderer.played.slice(1).every((play) => play.crossfadeMs > 0 && play.crossfadeMs < 300)).toBe(true);
  });
});
