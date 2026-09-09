import { Suspense, lazy } from 'react';
import type { ReactElement } from 'react';
import { packageInfo as core } from '@latentpresence/core';
import { PROTOCOL_VERSION } from '@latentpresence/protocol';
import { Gallery } from './Gallery';

/** The dev-only design-system page. Never routed in a production build (P0-T02b). */
export const GALLERY_PATH = '/gallery';

/** The dev-only voice-loop measurement page (P0-T04). */
export const SPIKE_VOICE_PATH = '/spike/voice';

/** The dev-only turn-detection measurement page (P0-T07). */
export const SPIKE_TURN_PATH = '/spike/turn';

/** The dev-only avatar and lip-sync measurement page (P0-T05). */
export const SPIKE_AVATAR_PATH = '/spike/avatar';

/** The dev-only webview capability probe (P0-T08). */
export const SPIKE_SHELL_PATH = '/spike/shell';

/**
 * The spike pulls in transformers.js, ONNX Runtime and kokoro-js — around 21 MB of wasm
 * on its own. A `lazy(() => import(...))` alone is not enough: Rollup emits the chunk
 * whether or not the route can be reached, so a production build shipped all of it.
 *
 * Returning before the import puts it in a branch that is provably dead once Vite
 * replaces `import.meta.env.DEV` with `false`, and the whole subtree is then dropped.
 * The build assertion for this is in `apps/web/vite.config.ts`.
 */
const VoiceLoop = lazy(async () => {
  // Never rendered — the route above is unreachable outside dev. It exists so the
  // import below sits in a branch Rollup can prove dead, and it matches VoiceLoop's
  // signature so `lazy` infers one component type rather than a union.
  if (!import.meta.env.DEV) return { default: (): ReactElement => <></> };
  const module = await import('./spikes/VoiceLoop');
  return { default: module.VoiceLoop };
});

/** Spike D, guarded the same way and for the same reason (P0-T07). */
const TurnDetect = lazy(async () => {
  if (!import.meta.env.DEV) return { default: (): ReactElement => <></> };
  const module = await import('./spikes/TurnDetect');
  return { default: module.TurnDetect };
});

/**
 * Spike B (P0-T05). Same guard again: three.js, three-vrm and react-three-fiber are a
 * megabyte of bundle for a route nobody can open. Unlike the other two, this one stops
 * being dev-only in Phase 2 — the avatar is the product.
 */
const AvatarStage = lazy(async () => {
  if (!import.meta.env.DEV) return { default: (): ReactElement => <></> };
  const module = await import('./spikes/AvatarStage');
  return { default: module.AvatarStage };
});

/**
 * Spike E (P0-T08). Guarded like the rest, though this one costs nothing to bundle — it
 * imports no model and no renderer. The guard is here for consistency and because the
 * route names an internal measurement page that has no business in a shipped build.
 */
const ShellProbe = lazy(async () => {
  if (!import.meta.env.DEV) return { default: (): ReactElement => <></> };
  const module = await import('./spikes/ShellProbe');
  return { default: module.ShellProbe };
});

/**
 * Boot screen. It exists so the scaffold proves the toolchain end to end: React 19
 * renders, the workspace packages resolve from the app, and theme.css is applied.
 * The stage and the call framing arrive in Phase 2.
 */
export function App({ path = window.location.pathname }: { path?: string }): ReactElement {
  if (import.meta.env.DEV && path === GALLERY_PATH) {
    return <Gallery />;
  }

  if (import.meta.env.DEV && path === SPIKE_VOICE_PATH) {
    return (
      <Suspense fallback={<p className="boot-status">Loading the spike…</p>}>
        <VoiceLoop />
      </Suspense>
    );
  }

  if (import.meta.env.DEV && path === SPIKE_TURN_PATH) {
    return (
      <Suspense fallback={<p className="boot-status">Loading the spike…</p>}>
        <TurnDetect />
      </Suspense>
    );
  }

  if (import.meta.env.DEV && path === SPIKE_AVATAR_PATH) {
    return (
      <Suspense fallback={<p className="boot-status">Loading the spike…</p>}>
        <AvatarStage />
      </Suspense>
    );
  }

  if (import.meta.env.DEV && path === SPIKE_SHELL_PATH) {
    return (
      <Suspense fallback={<p className="boot-status">Loading the spike…</p>}>
        <ShellProbe />
      </Suspense>
    );
  }

  return (
    <main className="boot-screen">
      <h1 className="boot-title">latentPresence</h1>
      <p className="boot-status">
        Scaffold online — protocol v{PROTOCOL_VERSION}, {core.name} linked.
      </p>
      {/* P0-T08. A Tauri window has no address bar, so without this list the shell opens
          on `/` and no spike route is reachable from inside it at all. Dev-only, like
          every route it links to. */}
      {import.meta.env.DEV && (
        <ul className="boot-routes">
          {[
            [GALLERY_PATH, 'Design-system gallery'],
            [SPIKE_SHELL_PATH, 'Spike E — webview capabilities'],
            [SPIKE_VOICE_PATH, 'Spike A — voice loop'],
            [SPIKE_TURN_PATH, 'Spike D — turn detection'],
            [SPIKE_AVATAR_PATH, 'Spike B — avatar and lip sync'],
          ].map(([href, label]) => (
            <li key={href}>
              <a href={href}>{label}</a>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
