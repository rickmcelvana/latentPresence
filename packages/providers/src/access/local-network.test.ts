import { describe, expect, it, vi } from 'vitest';
import { addressSpaceOf, localNetworkHelp, localNetworkNeeded, localNetworkPermission, type PermissionsLike } from './local-network';
import { probeEndpoint } from './probe';

const HOSTED = 'https://app.latentpresence.com';

/** Permissions as a browser answers them: a known name gives its state, an unknown one throws. */
function permissions(states: Record<string, string>): PermissionsLike {
  return {
    query: async ({ name }) => {
      const state = states[name];
      if (state === undefined) throw new TypeError(`'${name}' is not a valid value for enumeration PermissionName.`);
      return { state };
    },
  };
}

describe('local network access (P8-T03, ADR-64)', () => {
  it('places hosts the way browsers do', () => {
    for (const url of ['http://127.0.0.1:8787', 'http://localhost:11434', 'http://[::1]:1234', 'http://app.localhost', 'http://127.1.2.3']) {
      expect(addressSpaceOf(url), url).toBe('loopback');
    }
    for (const url of ['http://192.168.40.168/api/mcp', 'http://10.0.0.5', 'http://172.20.1.1', 'http://169.254.1.1', 'http://homeassistant.local:8123', 'http://[fd00::1]']) {
      expect(addressSpaceOf(url), url).toBe('local');
    }
    for (const url of [HOSTED, 'https://ollama.com/v1', 'http://172.32.0.1', 'http://8.8.8.8']) {
      expect(addressSpaceOf(url), url).toBe('public');
    }
    expect(addressSpaceOf('not a url')).toBeNull();
  });

  it('asks only about a request into a more private space than the page', () => {
    expect(localNetworkNeeded(HOSTED, 'http://127.0.0.1:8787/health')).toBe('loopback');
    expect(localNetworkNeeded(HOSTED, 'http://192.168.40.168/api/mcp')).toBe('local');
    expect(localNetworkNeeded(HOSTED, 'https://api.deepseek.com/v1')).toBeNull();
    expect(localNetworkNeeded('http://localhost:5173', 'http://127.0.0.1:8787')).toBeNull();
    expect(localNetworkNeeded('http://localhost:5173', 'http://192.168.40.168')).toBeNull();
    expect(localNetworkNeeded('http://192.168.40.5:4173', 'http://127.0.0.1:8787')).toBe('loopback');
  });

  it('reads the state by the name each browser knows, falling back to the older one', async () => {
    // Chrome 155 and Firefox 154 (measured): the split names.
    expect(await localNetworkPermission('loopback', permissions({ 'loopback-network': 'denied', 'local-network': 'prompt' }))).toBe('denied');
    expect(await localNetworkPermission('local', permissions({ 'loopback-network': 'denied', 'local-network': 'granted' }))).toBe('granted');
    // A Chrome that knows only the combined name.
    expect(await localNetworkPermission('loopback', permissions({ 'local-network-access': 'prompt' }))).toBe('prompt');
    // A browser that asks nothing.
    expect(await localNetworkPermission('loopback', permissions({}))).toBeNull();
    expect(await localNetworkPermission('loopback', null)).toBeNull();
  });

  it('a probe from the hosted app says when the browser, not the server, stopped it', async () => {
    const failed = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const timedOut = vi.fn(async () => {
      throw new DOMException('signal timed out', 'TimeoutError');
    });
    const local = (state: string) => ({ pageOrigin: HOSTED, permissions: permissions({ 'loopback-network': state, 'local-network': state }) });

    expect(await probeEndpoint('http://127.0.0.1:8787/health', { fetch: failed, localNetwork: local('denied') })).toEqual({ kind: 'browser-blocked', space: 'loopback' });
    expect(await probeEndpoint('http://127.0.0.1:8787/health', { fetch: timedOut, localNetwork: local('prompt') })).toEqual({ kind: 'browser-asking', space: 'loopback' });
    expect(await probeEndpoint('http://192.168.40.168/api/mcp', { fetch: failed, localNetwork: local('denied') })).toEqual({ kind: 'browser-blocked', space: 'local' });
    // Granted: the server really is not there.
    expect(await probeEndpoint('http://127.0.0.1:8787/health', { fetch: failed, localNetwork: local('granted') })).toEqual({ kind: 'unreachable' });
    // On this machine the browser asks nothing, whatever the state says.
    expect(await probeEndpoint('http://127.0.0.1:8787/health', { fetch: failed, localNetwork: { pageOrigin: 'http://localhost:5173', permissions: permissions({ 'loopback-network': 'denied' }) } })).toEqual({ kind: 'unreachable' });
    // An answer is an answer: nothing is asked.
    const query = vi.fn();
    expect(await probeEndpoint('http://127.0.0.1:8787/health', { fetch: async () => new Response('', { status: 200 }), localNetwork: { pageOrigin: HOSTED, permissions: { query } } })).toEqual({ kind: 'answered', status: 200 });
    expect(query).not.toHaveBeenCalled();
  });

  it('names each browser\'s own setting', () => {
    const blocked = localNetworkHelp('denied', 'loopback');
    expect(blocked.summary).toContain('apps on this computer');
    expect(blocked.steps.join(' ')).toContain('"Apps on device"');
    expect(blocked.steps.join(' ')).toContain('Device apps and services');
    expect(localNetworkHelp('prompt', 'local').summary).toContain('Choose Allow');
    expect(localNetworkHelp('denied', 'local').steps.join(' ')).toContain('Local network devices');
  });
});
