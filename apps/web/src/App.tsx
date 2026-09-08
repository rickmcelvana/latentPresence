import type { ReactElement } from 'react';
import { packageInfo as core } from '@latentpresence/core';
import { PROTOCOL_VERSION } from '@latentpresence/protocol';

/**
 * Boot screen. It exists so the scaffold proves the toolchain end to end: React 19
 * renders, the workspace packages resolve from the app, and theme.css is applied.
 * The stage and the call framing arrive in Phase 2.
 */
export function App(): ReactElement {
  return (
    <main className="boot">
      <h1 className="boot__title">latentPresence</h1>
      <p className="boot__status">
        Scaffold online — protocol v{PROTOCOL_VERSION}, {core.name} linked.
      </p>
    </main>
  );
}
