import { useState, type ReactElement } from 'react';
import { formatMb } from '../consent/format';
import type { PluginConsentFacts } from './inspect';

/**
 * Installing a plugin asks first (P10-T03, ADR-72 item 8): who made it and under what licence,
 * where it came from, every host it may contact, what it may download, the tools it adds and
 * whether they ask, the servers and schedules it would offer, and its cost in the prompt. Nothing
 * is kept until Install is pressed.
 */
export interface PluginConsentProps {
  readonly facts: PluginConsentFacts;
  /** The installed version this would replace, if any. */
  readonly replaces: string | null;
  /** The active character's name: installing can turn it on for them. */
  readonly characterName: string;
  readonly onInstall: (enableForCharacter: boolean) => void;
  readonly onCancel: () => void;
}

function originText(facts: PluginConsentFacts): string {
  switch (facts.origin.kind) {
    case 'folder':
      return `the folder "${facts.origin.name}"`;
    case 'zip':
      return `the file "${facts.origin.name}"`;
    case 'url':
      return facts.origin.url;
  }
}

function kept(bytes: number): string {
  return bytes < 100_000 ? `${Math.max(1, Math.round(bytes / 1000))} kB` : formatMb(bytes);
}

export function PluginConsent({ facts, replaces, characterName, onInstall, onCancel }: PluginConsentProps): ReactElement {
  const [enable, setEnable] = useState(true);
  return (
    <section aria-label={`Install ${facts.name}`} className="panel consent-screen plugin-consent">
      <div className="panel-header">
        <span className="panel-title">
          Install {facts.name} {facts.version}?
        </span>
        {facts.downloadBytes > 0 ? <span className="pill pill-accent">up to {formatMb(facts.downloadBytes)}</span> : null}
      </div>
      <p className="consent-note">{facts.summary}</p>
      <dl className="plugin-facts">
        <dt>By</dt>
        <dd>
          {facts.author} · {facts.licence}
          {facts.homepage === null ? null : (
            <>
              {' · '}
              <a href={facts.homepage} rel="noreferrer" target="_blank">
                homepage
              </a>
            </>
          )}
        </dd>
        <dt>From</dt>
        <dd className="plugin-facts-wrap">{originText(facts)}</dd>
        <dt>Contacts</dt>
        <dd>{facts.hosts.length === 0 ? 'No one: everything it needs is in it.' : facts.hosts.join(', ')}</dd>
        <dt>Downloads</dt>
        <dd>
          {facts.downloadBytes === 0 ? 'Nothing.' : `Up to ${formatMb(facts.downloadBytes)}, each picture the first time it is shown, checked against the plugin's own list.`} Keeps {kept(facts.keptBytes)} in
          this browser.
        </dd>
        {facts.assetLicences.length === 0 ? null : (
          <>
            <dt>Pictures</dt>
            <dd>{facts.assetLicences.map(({ licence, count }) => `${count} × ${licence}`).join(', ')}</dd>
          </>
        )}
        <dt>Prompt</dt>
        <dd>
          About {facts.promptTokens.idle} tokens in every conversation while it is on, and about {facts.promptTokens.used} more once she uses it (an estimate).
        </dd>
      </dl>

      {facts.tools.length === 0 ? null : (
        <ul aria-label="Tools it adds" className="consent-models">
          {facts.tools.map((tool) => (
            <li className="consent-model" key={tool.name}>
              <span className="consent-model-name plugin-mono">{tool.name}</span>
              <span className="consent-model-meta">
                {tool.description} {tool.policy === 'auto' ? 'Runs without asking: it touches nothing outside the plugin.' : 'Asks you each time.'}
              </span>
            </li>
          ))}
        </ul>
      )}
      {facts.mcp.length === 0 ? null : (
        <ul aria-label="Servers it asks for" className="consent-models">
          {facts.mcp.map((server) => (
            <li className="consent-model" key={server.name}>
              <span className="consent-model-name">Server: {server.name}</span>
              <span className="consent-model-meta plugin-mono plugin-facts-wrap">{server.detail}</span>
              <span className="consent-model-meta">Offered separately when you turn the plugin on; not added by installing.</span>
            </li>
          ))}
        </ul>
      )}
      {facts.schedules.length === 0 ? null : (
        <ul aria-label="Schedules it offers" className="consent-models">
          {facts.schedules.map((schedule) => (
            <li className="consent-model" key={schedule.description}>
              <span className="consent-model-name">Schedule: {schedule.description}</span>
              <span className="consent-model-meta">Offered when you turn the plugin on; nothing is scheduled by installing.</span>
            </li>
          ))}
        </ul>
      )}
      {facts.notes.map((note) => (
        <p className="field-hint" key={note}>
          {note}
        </p>
      ))}
      {replaces === null ? null : <p className="field-hint">This replaces version {replaces}; its settings and what it kept stay.</p>}

      <label className="tools-switch">
        <input checked={enable} onChange={(event) => setEnable(event.target.checked)} type="checkbox" />
        Turn it on for {characterName}
      </label>
      <div className="consent-actions">
        <button className="btn btn-primary" onClick={() => onInstall(enable)} type="button">
          Install
        </button>
        <button className="btn btn-ghost" onClick={onCancel} type="button">
          Cancel
        </button>
      </div>
    </section>
  );
}
