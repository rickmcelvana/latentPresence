import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EndpointProbe, HttpFetch } from '@latentpresence/providers/web';
import { loadPairingCode, savePairingCode } from './companion-pairing';
import { CompanionSection, companionCheckMessage, pageNeedsPairing } from './CompanionSection';
import { COMPANION_NEEDS_PAIRING } from './connection';

afterEach(cleanup);

const HOSTED = 'https://app.latentpresence.com';
const URL_C = 'http://127.0.0.1:8787';

function memoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size;
    },
  } as Storage;
}

const noFetch = (async () => new Response('')) as HttpFetch;

function mount(origin: string, answers: EndpointProbe[], storage = memoryStorage()) {
  const probe = vi.fn(async (): Promise<EndpointProbe> => answers.shift() ?? { kind: 'unreachable' });
  const onChange = vi.fn();
  render(<CompanionSection companionUrl={URL_C} fetch={noFetch} onChangeCompanionUrl={onChange} origin={origin} probe={probe} storage={storage} />);
  return { probe, onChange, storage, section: within(screen.getByRole('region', { name: 'Companion' })) };
}

describe('Settings → Companion in a browser (P8-T03, ADR-64)', () => {
  it('asks for a pairing code only on a page that is not on this computer', () => {
    expect(pageNeedsPairing(HOSTED)).toBe(true);
    expect(pageNeedsPairing('http://localhost:5173')).toBe(false);
    expect(pageNeedsPairing('http://127.0.0.1:4173')).toBe(false);

    const local = mount('http://localhost:5173', []);
    expect(local.section.queryByLabelText('Pairing code')).toBeNull();
    expect(local.section.getByLabelText('Address')).toBeTruthy();
    cleanup();
    const hosted = mount(HOSTED, []);
    expect((hosted.section.getByLabelText('Pairing code') as HTMLInputElement).type).toBe('password');
  });

  it('the address is the settings\' own', () => {
    const { section, onChange } = mount(HOSTED, []);
    fireEvent.change(section.getByLabelText('Address'), { target: { value: 'http://127.0.0.1:9000' } });
    expect(onChange).toHaveBeenCalledWith('http://127.0.0.1:9000');
  });

  it('Save keeps the code, shows it only as saved, and checks at once', async () => {
    const { section, storage, probe } = mount(HOSTED, [{ kind: 'answered', status: 200 }]);
    fireEvent.change(section.getByLabelText('Pairing code'), { target: { value: 'abcd-efgh-2345' } });
    fireEvent.click(section.getByRole('button', { name: 'Save' }));
    expect(loadPairingCode(storage)).toBe('ABCDEFGH2345');
    expect(section.getByText('Saved in this browser')).toBeTruthy();
    expect(section.queryByDisplayValue(/ABCD/i)).toBeNull();
    expect(await section.findByText('Connected.')).toBeTruthy();
    expect(probe).toHaveBeenCalledWith(`${URL_C}/health`, { fetch: noFetch });

    fireEvent.click(section.getByRole('button', { name: 'Forget' }));
    expect(loadPairingCode(storage)).toBeNull();
    expect(section.getByRole('button', { name: 'Save' })).toBeTruthy();
  });

  it('Check says what stands in the way', async () => {
    const storage = memoryStorage();
    const { section } = mount(HOSTED, [{ kind: 'answered', status: 401 }, { kind: 'browser-asking', space: 'loopback' }, { kind: 'unreachable' }], storage);
    fireEvent.click(section.getByRole('button', { name: 'Check' }));
    expect(await section.findByText(COMPANION_NEEDS_PAIRING)).toBeTruthy();
    fireEvent.click(section.getByRole('button', { name: 'Check' }));
    expect(await section.findByText(/Choose Allow, then try again/)).toBeTruthy();
    fireEvent.click(section.getByRole('button', { name: 'Check' }));
    expect(await section.findByText(/Nothing is answering at http:\/\/127.0.0.1:8787\. Start it/)).toBeTruthy();
  });

  it('a refused code is told apart from a missing one', () => {
    expect(companionCheckMessage({ kind: 'answered', status: 401 }, URL_C, HOSTED, true).text).toContain('refused this pairing code');
    expect(companionCheckMessage({ kind: 'answered', status: 401 }, URL_C, HOSTED, false).text).toBe(COMPANION_NEEDS_PAIRING);
    expect(companionCheckMessage({ kind: 'browser-blocked', space: 'loopback' }, URL_C, HOSTED, true).help?.steps.join(' ')).toContain('Apps on device');
  });

  it('a code saved earlier shows as saved, and Replace asks for a new one', async () => {
    const storage = memoryStorage();
    savePairingCode(storage, 'WXYZ');
    const { section } = mount(HOSTED, [], storage);
    expect(section.getByText('Saved in this browser')).toBeTruthy();
    fireEvent.click(section.getByRole('button', { name: 'Replace' }));
    await waitFor(() => expect(section.getByRole('button', { name: 'Cancel' })).toBeTruthy());
  });
});
