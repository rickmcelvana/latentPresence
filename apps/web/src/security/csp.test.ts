import { describe, expect, it } from 'vitest';
import { CONTENT_SECURITY_POLICY, cspValue } from './csp';

/** P9-T03 (ADR-69). `e2e/csp.spec.ts` proves the built pages run under it; this keeps it strict. */
describe('the Content Security Policy', () => {
  it('runs only the build’s own scripts: no inline script, no eval, no plugin, no base rewrite', () => {
    expect(CONTENT_SECURITY_POLICY['script-src']).toEqual(["'self'", "'wasm-unsafe-eval'"]);
    expect(CONTENT_SECURITY_POLICY['worker-src']).toEqual(["'self'"]);
    expect(CONTENT_SECURITY_POLICY['object-src']).toEqual(["'none'"]);
    expect(CONTENT_SECURITY_POLICY['base-uri']).toEqual(["'none'"]);
    for (const sources of Object.values(CONTENT_SECURITY_POLICY)) {
      expect(sources).not.toContain("'unsafe-inline'");
      expect(sources).not.toContain("'unsafe-eval'");
      expect(sources).not.toContain('*');
    }
  });

  it('is written as a header value', () => {
    expect(cspValue({ 'default-src': ["'self'"], 'img-src': ["'self'", 'data:'] })).toBe("default-src 'self'; img-src 'self' data:");
  });
});
