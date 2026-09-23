import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationMachine } from '@latentpresence/core';
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
        call={null}
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
      <CallStage call={null} consent={consent} createRenderer={() => renderer} fetchModel={fetchModel} machine={machine()} />,
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
      <CallStage call={null} consent={consent} createRenderer={() => renderer} fetchModel={fetchModel} machine={machine()} />,
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
      <CallStage call={null} consent={consent} createRenderer={() => renderer} fetchModel={fetchModel} machine={machine()} />,
    );
    await settle();

    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    await settle();

    expect(fetchModel).not.toHaveBeenCalled();
    expect(renderer.character).toBeNull();
    expect(screen.getByRole('button', { name: 'Show the character' })).toBeTruthy();
  });
});
