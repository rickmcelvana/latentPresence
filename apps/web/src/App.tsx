import { Suspense, lazy } from 'react';
import type { ReactElement } from 'react';
import { packageInfo as core } from '@latentpresence/core';
import { PROTOCOL_VERSION } from '@latentpresence/protocol';
import { Gallery } from './Gallery';

/** The dev-only design-system page. Never routed in a production build (P0-T02b). */
export const GALLERY_PATH = '/gallery';

/**
 * The dev-only voice harness (P1-T08): the promoted pipeline — turn detection, recognition,
 * synthesis, the output queue and barge-in — with a scripted model. It replaced Spike A's
 * `/spike/voice`, which measured the same loop with throwaway workers.
 */
export const DEV_VOICE_PATH = '/dev/voice';

/**
 * The dev-only end-to-end page (P1-T14), driven by Playwright rather than by a person:
 * the same wiring as `/dev/voice` with the model, the voice and recognition faked, so it
 * needs no WebGPU and downloads only Silero's 2.2 MB.
 */
export const DEV_E2E_PATH = '/dev/e2e';

/** The dev-only VRM renderer debug panel (P2-T01): every expression, mouth shape, gaze
 * target and clip, on the placeholder character. */
export const DEV_AVATAR_PATH = '/dev/avatar';

/** The dev-only voice-emotion timing page (P3-T05): a model in its real worker, timed per segment. */
export const DEV_SER_PATH = '/dev/ser';

/** The dev-only face-reading page (P3-T06): the landmarker in its real worker, timed, and the heuristic scored. */
export const DEV_FACE_PATH = '/dev/face';

/** The dev-only avatar and lip-sync measurement page (P0-T05). */
export const SPIKE_AVATAR_PATH = '/spike/avatar';

/** The dev-only webview capability probe (P0-T08). */
export const SPIKE_SHELL_PATH = '/spike/shell';

/** The settings page (P1-T10). Ships in production — providers, voice and hearing are
 * configured here — unlike every other route in this file. */
export const SETTINGS_PATH = '/settings';

/** `/chat` (P1-T11). Ships in production, like `/settings` — the transcript and a typed
 * conversation with the model `/settings` configured. */
export const CHAT_PATH = '/chat';

/**
 * The harness pulls in transformers.js, ONNX Runtime and kokoro-js — around 21 MB of wasm
 * on its own. A `lazy(() => import(...))` alone is not enough: Rollup emits the chunk
 * whether or not the route can be reached, so a production build shipped all of it.
 *
 * Returning before the import puts it in a branch that is provably dead once Vite
 * replaces `import.meta.env.DEV` with `false`, and the whole subtree is then dropped.
 * The build assertion for this is in `apps/web/vite.config.ts`.
 */
const VoiceHarness = lazy(async () => {
  // Never rendered — the route above is unreachable outside dev. It exists so the
  // import below sits in a branch Rollup can prove dead, and it matches VoiceHarness's
  // signature so `lazy` infers one component type rather than a union.
  if (!import.meta.env.DEV) return { default: (): ReactElement => <></> };
  const module = await import('./dev/VoiceHarness');
  return { default: module.VoiceHarness };
});

/** P1-T14's page, behind the same dead-branch guard as the harness above. */
const E2EPage = lazy(async () => {
  if (!import.meta.env.DEV) return { default: (): ReactElement => <></> };
  const module = await import('./dev/E2EPage');
  return { default: module.E2EPage };
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

/** P2-T01's debug panel, behind the same guard: it pulls in three.js and three-vrm. */
const AvatarDebug = lazy(async () => {
  if (!import.meta.env.DEV) return { default: (): ReactElement => <></> };
  const module = await import('./dev/AvatarDebug');
  return { default: module.AvatarDebug };
});

/** P3-T05's timing page, behind the same guard: it makes the ONNX Runtime worker. */
const SerBench = lazy(async () => {
  if (!import.meta.env.DEV) return { default: (): ReactElement => <></> };
  const module = await import('./dev/SerBench');
  return { default: module.SerBench };
});

/** P3-T06's face bench, behind the same guard: it makes the MediaPipe worker. */
const FaceBench = lazy(async () => {
  if (!import.meta.env.DEV) return { default: (): ReactElement => <></> };
  const module = await import('./dev/FaceBench');
  return { default: module.FaceBench };
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
 * The settings page (P1-T10). `lazy()` alone here is the point, not a build-exclusion
 * guard like the three above: the AI SDK the page pulls in is most of an 830 kB chunk,
 * and the boot screen should render before that finishes loading rather than wait on it.
 * Unlike the dev routes, this one is real in every build.
 */
const SettingsPage = lazy(async () => {
  const module = await import('./settings/SettingsPage');
  return { default: module.SettingsPage };
});

/**
 * `/chat` (P1-T11). `lazy()` for the same reason as `/settings`: it pulls in the AI SDK
 * through the LLM provider it builds, so the boot screen should not wait on that chunk.
 * Real in every build, unlike the dev routes above.
 */
const ChatPage = lazy(async () => {
  const module = await import('./chat/ChatPage');
  return { default: module.ChatPage };
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

  if (import.meta.env.DEV && path === DEV_VOICE_PATH) {
    return (
      <Suspense fallback={<p className="boot-status">Loading the harness…</p>}>
        <VoiceHarness />
      </Suspense>
    );
  }

  if (import.meta.env.DEV && path === DEV_E2E_PATH) {
    return (
      <Suspense fallback={<p className="boot-status">Loading the end-to-end harness…</p>}>
        <E2EPage />
      </Suspense>
    );
  }

  if (import.meta.env.DEV && path === DEV_AVATAR_PATH) {
    return (
      <Suspense fallback={<p className="boot-status">Loading the avatar panel…</p>}>
        <AvatarDebug />
      </Suspense>
    );
  }

  if (import.meta.env.DEV && path === DEV_SER_PATH) {
    return (
      <Suspense fallback={<p className="boot-status">Loading the voice-emotion bench…</p>}>
        <SerBench />
      </Suspense>
    );
  }

  if (import.meta.env.DEV && path === DEV_FACE_PATH) {
    return (
      <Suspense fallback={<p className="boot-status">Loading the face bench…</p>}>
        <FaceBench />
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

  if (path === SETTINGS_PATH) {
    return (
      <Suspense fallback={<p className="boot-status">Loading settings…</p>}>
        <SettingsPage />
      </Suspense>
    );
  }

  if (path === CHAT_PATH) {
    return (
      <Suspense fallback={<p className="boot-status">Loading chat…</p>}>
        <ChatPage />
      </Suspense>
    );
  }

  return (
    <main className="boot-screen">
      <h1 className="boot-title">latentPresence</h1>
      <p className="boot-status">
        Scaffold online — protocol v{PROTOCOL_VERSION}, {core.name} linked.
      </p>
      {/* Ships for everyone, unlike the dev-only list below — a new user needs a way to
          configure a provider before there is anything else on this screen to click. */}
      <p className="boot-status">
        <a href={SETTINGS_PATH}>Settings</a> · <a href={CHAT_PATH}>Chat</a>
      </p>
      {/* P0-T08. A Tauri window has no address bar, so without this list the shell opens
          on `/` and no spike route is reachable from inside it at all. Dev-only, like
          every route it links to. */}
      {import.meta.env.DEV && (
        <ul className="boot-routes">
          {[
            [GALLERY_PATH, 'Design-system gallery'],
            [SPIKE_SHELL_PATH, 'Spike E — webview capabilities'],
            [DEV_VOICE_PATH, 'Voice harness — queue and barge-in (P1-T08)'],
            [DEV_AVATAR_PATH, 'Avatar — VRM renderer debug panel (P2-T01)'],
            [DEV_SER_PATH, 'Voice emotion — worker timing (P3-T05)'],
            [DEV_FACE_PATH, 'Face reading — worker and heuristic (P3-T06)'],
            [SPIKE_AVATAR_PATH, 'Spike B — avatar frame rate and lip sync'],
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
