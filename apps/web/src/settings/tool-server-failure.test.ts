import { describe, expect, it } from 'vitest';
import { describeToolServerFailure, looksLikeHomeAssistant } from './tool-server-failure';

const base = { detail: 'Failed to fetch', origin: 'http://tauri.localhost' };

describe('describeToolServerFailure (P8-T06)', () => {
  it("says a Home Assistant that refuses the app is up, and sends the app's person to its own section", () => {
    const text = describeToolServerFailure({ ...base, url: 'http://192.168.40.168/api/mcp', probe: { kind: 'cors-blocked' }, inApp: true });
    expect(text).toContain('192.168.40.168 is running');
    expect(text).toContain('Settings → Home Assistant');
    expect(text).not.toMatch(/not up|not running/i);
  });

  it('in a browser, names the companion and the CORS setting with the exact origin', () => {
    const text = describeToolServerFailure({ ...base, origin: 'http://localhost:5173', url: 'http://ha.local:8123/api/mcp', probe: { kind: 'cors-blocked' }, inApp: false });
    expect(text).toContain('mcp.json');
    expect(text).toContain('http://localhost:5173');
  });

  it('a server that is not Home Assistant and refuses the page points at the companion list', () => {
    expect(describeToolServerFailure({ ...base, url: 'http://nas.local:3000/mcp', probe: { kind: 'cors-blocked' }, inApp: true })).toContain('Open mcp.json');
  });

  it('from the hosted app, says the browser is asking or blocking rather than "nothing answered" (ADR-64)', () => {
    const asking = describeToolServerFailure({ ...base, origin: 'https://app.latentpresence.com', url: 'http://192.168.40.168/api/mcp', probe: { kind: 'browser-asking', space: 'local' }, inApp: false });
    expect(asking).toContain('Choose Allow');
    const blocked = describeToolServerFailure({ ...base, origin: 'https://app.latentpresence.com', url: 'http://192.168.40.168/api/mcp', probe: { kind: 'browser-blocked', space: 'local' }, inApp: false });
    expect(blocked).toContain('blocking this site from reaching devices on your network');
    expect(blocked).not.toContain('Nothing answered');
  });

  it('tells nothing-there, slow, wrong path and a refused token apart', () => {
    expect(describeToolServerFailure({ ...base, url: 'http://10.0.0.9/mcp', probe: { kind: 'unreachable' }, inApp: true })).toContain('Nothing answered at 10.0.0.9');
    expect(describeToolServerFailure({ ...base, url: 'http://10.0.0.9/mcp', probe: { kind: 'timeout' }, inApp: true })).toContain('within 5 seconds');
    expect(describeToolServerFailure({ ...base, url: 'http://10.0.0.9/x', probe: { kind: 'answered', status: 404 }, inApp: true })).toContain('no MCP endpoint');
    expect(describeToolServerFailure({ ...base, detail: 'HTTP 401 Unauthorized', url: 'http://10.0.0.9/mcp', probe: { kind: 'answered', status: 401 }, inApp: true })).toContain('refused the token');
    // A 401 to the probe alone means nothing: the probe sends no token.
    expect(describeToolServerFailure({ ...base, detail: 'bad handshake', url: 'http://10.0.0.9/mcp', probe: { kind: 'answered', status: 401 }, inApp: true })).toContain('bad handshake');
  });

  it('knows Home Assistant by its path, its port or its name', () => {
    expect(looksLikeHomeAssistant('http://192.168.1.5/api/mcp/')).toBe(true);
    expect(looksLikeHomeAssistant('http://192.168.1.5:8123/')).toBe(true);
    expect(looksLikeHomeAssistant('http://homeassistant.local/x')).toBe(true);
    expect(looksLikeHomeAssistant('http://nas.local:3000/mcp')).toBe(false);
  });
});
