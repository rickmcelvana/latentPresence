import type { ReactElement } from 'react';
import { BODY_FILE, BODY_SOURCE } from '@latentpresence/ml-web/registry';
import { REGISTRY, registryFiles, type RegistryEntry } from '@latentpresence/ml-web/registry/catalog';
import { AppNav } from '../AppNav';
import { AVATAR } from '../call/character-asset';
import { formatMb } from '../consent/format';

/**
 * The privacy page and the model registry (P9-T05, ADR-70). Both are promises the code has to
 * keep, so they ship with the code rather than with the site, and they read the way the rest of
 * the app does: what happens, without reassurance. Every line here was checked against the code
 * on 2026-11-03; a change to where something goes changes this page and `docs/security.md`.
 */

const BODY_ENTRY: RegistryEntry = {
  id: 'body',
  name: AVATAR.label,
  does: `Her body until you give her your own. By ${AVATAR.author}. ${AVATAR.terms}`,
  licence: AVATAR.licence,
  sourceUrl: AVATAR.sourceUrl,
  sizes: [AVATAR.bytes],
  sources: [BODY_SOURCE],
};

const ENTRIES: readonly RegistryEntry[] = [...REGISTRY, BODY_ENTRY];

/** Where each thing goes when, and only when, you set it up. */
const DESTINATIONS: readonly { readonly what: string; readonly where: string; readonly when: string }[] = [
  {
    what: 'What you say, a word for how you seem to her, her character, what she remembers that bears on it, and what her tools read',
    where: 'The language model you chose',
    when: 'Every reply. The word comes from your words, voice or face. With Moonshine or Whisper the model gets no audio, and it never gets a picture. A cloud provider handles all of this under its own terms; a model on your own computer or network keeps it there.',
  },
  {
    what: 'Your recorded speech',
    where: 'The speech server you named',
    when: 'Only if Hearing is set to an OpenAI-compatible server. Moonshine and Whisper run on this computer.',
  },
  {
    what: 'The sentences she is about to say',
    where: 'The voice server you named',
    when: 'Only if Voice is set to an OpenAI-compatible server. Kokoro runs on this computer.',
  },
  {
    what: 'Her memory',
    where: 'This browser, or the MariaDB your companion connects to',
    when: 'While memory is on. Settings says which, and you can read, correct or delete any of it in the memory panel.',
  },
  {
    what: 'The text of documents you add',
    where: 'The embedding server you named',
    when: 'Only when you add documents through the companion.',
  },
  {
    what: 'What she searches for, and the addresses of pages she reads',
    where: 'Your search provider, and those sites',
    when: 'Only if you turned on web tools. Those requests come from your companion.',
  },
  {
    what: 'What a tool is asked to do',
    where: 'Home Assistant, your databases, and the tool servers you added',
    when: 'Only those you set up. In Settings each tool asks you first, runs on its own, or never runs.',
  },
];

/** A config file is a few hundred bytes, which "0.0 MB" would hide. */
function fileSize(bytes: number): string {
  return bytes < 100_000 ? `${Math.max(1, Math.round(bytes / 1_000))} kB` : formatMb(bytes);
}

function sizeText(sizes: readonly number[]): string {
  const smallest = sizes[0] ?? 0;
  const largest = sizes[sizes.length - 1] ?? 0;
  return smallest === largest ? formatMb(smallest) : `${formatMb(smallest)} to ${formatMb(largest)}`;
}

function RegistryRow({ entry }: { readonly entry: RegistryEntry }): ReactElement {
  const files = registryFiles(entry.sources);
  const revisions = [...new Set(files.map((file) => file.revision))];
  return (
    <li className="registry-entry">
      <div className="registry-entry-head">
        <span className="registry-entry-name">{entry.name}</span>
        <span className="registry-entry-size">{sizeText(entry.sizes)}</span>
      </div>
      <p className="registry-entry-does">{entry.does}</p>
      <p className="registry-entry-meta">
        {entry.licence} ·{' '}
        <a href={entry.sourceUrl} rel="noreferrer" target="_blank">
          source
        </a>{' '}
        · pinned to <code className="registry-code">{revisions.map((revision) => revision.slice(0, 9)).join(', ')}</code>
      </p>
      <details className="registry-files">
        <summary>{files.length === 1 ? 'The file and its SHA-256' : `The ${files.length} files it can fetch, and their SHA-256`}</summary>
        <ul className="registry-file-list">
          {files.map((file) => (
            <li className="registry-file" key={`${file.source}/${file.path}`}>
              <span className="registry-file-path">{file.path === BODY_FILE ? file.path.split('/').at(-1) : file.path}</span>
              <span className="registry-file-size">{fileSize(file.bytes)}</span>
              <code className="registry-code registry-file-hash">{file.sha256}</code>
            </li>
          ))}
        </ul>
      </details>
    </li>
  );
}

export function PrivacyPage(): ReactElement {
  return (
    <>
      <AppNav current="/privacy" />
      <main className="privacy-page">
        <header className="privacy-header">
          <h1 className="privacy-title">Privacy</h1>
          <p className="privacy-lead">Nothing leaves your machine unless you point it somewhere.</p>
          <p className="privacy-note">
            There is no account and no telemetry: this app reports nothing about you or how you use it to anyone. Its source is{' '}
            <a href="https://github.com/rickmcelvana/latentPresence" rel="noreferrer" target="_blank">
              public
            </a>
            , so you can check this page against it.
          </p>
        </header>

        <section className="panel privacy-section">
          <div className="panel-header">
            <span className="panel-title">What stays on this computer</span>
          </div>
          <ul className="privacy-list">
            <li>What your microphone hears, with Moonshine or Whisper. It is turned into text here and the audio goes no further.</li>
            <li>Your camera, if you turn on face reading. A model here reads each frame and drops it. No frame is stored or sent.</li>
            <li>Your settings. API keys are encrypted in this browser, or kept in Windows Credential Manager in the desktop app.</li>
            <li>The bodies you add. A .vrm of your own is read from this computer and goes nowhere.</li>
          </ul>
        </section>

        <section className="panel privacy-section">
          <div className="panel-header">
            <span className="panel-title">What goes where you point it</span>
          </div>
          <ul className="privacy-destinations">
            {DESTINATIONS.map((row) => (
              <li className="privacy-destination" key={row.what}>
                <span className="privacy-destination-what">{row.what}</span>
                <span className="privacy-destination-where">{row.where}</span>
                <span className="privacy-destination-when">{row.when}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="panel privacy-section">
          <div className="panel-header">
            <span className="panel-title">Who else sees your computer's address</span>
          </div>
          <ul className="privacy-list">
            <li>
              <strong>The hosts of what you download.</strong> Hugging Face, Google or GitHub, the first time a model or body downloads, and only after you agree on a screen that gives its size, licence and source. They see a download, not anything you say.
            </li>
            <li>
              <strong>GitHub, for updates in the desktop app.</strong> Only when you press Check for updates, or if you turned on the check at start. It is off until you do.
            </li>
            <li>
              <strong>The server, if you use the hosted app.</strong> app.latentpresence.com sends the page's files, and like any web server it sees your address when it does. Nothing you say or set up goes to it: the hosted app has no server side.
            </li>
          </ul>
        </section>

        <section className="panel privacy-section">
          <div className="panel-header">
            <span className="panel-title">Every model this app can download</span>
            <span className="pill pill-accent">{ENTRIES.length}</span>
          </div>
          <p className="privacy-note">
            This app ships no models. Each download is pinned to a fixed version and checked against the SHA-256 below before it is used or kept, so what you agreed to cannot change underneath you. Delete them any time in{' '}
            <a href="/settings">Settings, Downloaded models</a>.
          </p>
          <ul className="registry-list">
            {ENTRIES.map((entry) => (
              <RegistryRow entry={entry} key={entry.id} />
            ))}
          </ul>
        </section>
      </main>
    </>
  );
}
