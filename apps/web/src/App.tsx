import type { ReactElement } from 'react';
import { packageInfo as core } from '@latentpresence/core';
import { PROTOCOL_VERSION } from '@latentpresence/protocol';
import { Gallery } from './Gallery';

/** The dev-only design-system page. Never routed in a production build (P0-T02b). */
export const GALLERY_PATH = '/gallery';

/**
 * Boot screen. It exists so the scaffold proves the toolchain end to end: React 19
 * renders, the workspace packages resolve from the app, and theme.css is applied.
 * The stage and the call framing arrive in Phase 2.
 */
export function App({ path = window.location.pathname }: { path?: string }): ReactElement {
  if (import.meta.env.DEV && path === GALLERY_PATH) {
    return <Gallery />;
  }

  return (
    <main className="boot-screen">
      <h1 className="boot-title">latentPresence</h1>
      <p className="boot-status">
        Scaffold online — protocol v{PROTOCOL_VERSION}, {core.name} linked.
      </p>
    </main>
  );
}
