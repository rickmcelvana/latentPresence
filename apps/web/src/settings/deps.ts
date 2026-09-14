import { probeEndpoint, type HttpFetch } from '@latentpresence/providers/web';
import { vault as realVault, Vault } from './vault';

/**
 * Everything a section needs from the outside world, gathered in one small bag so a test
 * can replace all of it at once (P1-T10). No component reaches for `fetch`, `probeEndpoint`
 * or the real vault directly — it asks its `deps` prop, which defaults to the real thing.
 */
/** The slice of `AudioContext` "Play sample" needs, so a test can inject a fake one
 * rather than requiring jsdom to implement Web Audio. */
export interface MinimalAudioContext {
  readonly destination: AudioDestinationNode;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer;
  createBufferSource(): AudioBufferSourceNode;
  close(): Promise<void>;
}

export interface SettingsDeps {
  readonly vault: Vault;
  readonly storage: Pick<Storage, 'getItem' | 'setItem'>;
  readonly fetch: HttpFetch;
  readonly probe: typeof probeEndpoint;
  readonly origin: string;
  readonly now: () => number;
  /** Builds a fresh audio context for one playback — "create the context on the click"
   * (P1-T10), never held between clicks. */
  readonly createAudioContext: () => MinimalAudioContext;
}

export function defaultSettingsDeps(): SettingsDeps {
  return {
    vault: realVault,
    storage: window.localStorage,
    fetch: (input, init) => window.fetch(input, init),
    probe: probeEndpoint,
    origin: window.location.origin,
    now: () => Date.now(),
    createAudioContext: () => new AudioContext(),
  };
}
