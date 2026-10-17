import { useEffect } from 'react';
import type { ReactElement } from 'react';
import type { CompanionController } from './companion-config-state';
import { DatabasesPanel, DocumentsPanel, FileButtons, FilesPanel, HomePanel, ProgramsPanel, WebPanel } from './CompanionPanels';

/**
 * A file that does not parse: its sentence(s), and the two things to do about it. The sections
 * then show empty, and nothing in them can be changed until it is fixed.
 */
export function ProblemsBanner({ controller }: { readonly controller: CompanionController }): ReactElement | null {
  const problems = controller.config?.problems ?? [];
  if (problems.length === 0) return null;
  return (
    <section aria-label="A file could not be read" className="panel settings-section companion-problems">
      <div className="panel-header">
        <span className="panel-title">A file could not be read</span>
      </div>
      {problems.map((problem) => (
        <p className="settings-status settings-status-danger" key={problem}>
          {problem}
        </p>
      ))}
      <p className="field-hint">Fix the file, then press Reload. Until then the sections below cannot be changed.</p>
      <FileButtons controller={controller} />
    </section>
  );
}

/** Why the sections are not there yet: "Looking…", or the sentence the read failed with, and Retry. */
export function LoadState({ controller }: { readonly controller: CompanionController }): ReactElement | null {
  if (controller.config !== null) return null;
  if (controller.loadError !== null) {
    return (
      <div className="settings-test-row">
        <p className="settings-status settings-status-danger">{controller.loadError}</p>
        <button className="btn btn-sm" disabled={controller.loading} onClick={controller.retry} type="button">
          Retry
        </button>
      </div>
    );
  }
  return <p className="field-hint">Looking…</p>;
}

export interface CompanionSettingsProps {
  readonly controller: CompanionController;
}

/**
 * Settings → On this computer (P8-T06), in the desktop app only: Home Assistant, the folders she
 * may read, the documents she can search, web search, databases and the programs `mcp.json`
 * starts. What `mcp.json` and `documents.json` held by hand, changed here through the shell. The
 * caller (`SettingsPanel`) decides it is the app and builds the controller.
 */
export function CompanionSettings({ controller }: CompanionSettingsProps): ReactElement {
  const { load } = controller;
  useEffect(() => {
    load();
  }, [load]);

  const config = controller.config;
  const locked = (config?.problems.length ?? 0) > 0;

  return (
    <>
      <div className="settings-group">
        <h2 className="settings-group-heading">On this computer</h2>
        <p className="panel-note">
          What the companion can reach from this computer. Changes restart the companion; her tools from it are back in a few seconds.
        </p>
        <div aria-live="polite" className="settings-status-region">
          {controller.busy && <p className="settings-status settings-status-warn">Working… the companion restarts after each change.</p>}
        </div>
      </div>
      <LoadState controller={controller} />
      {config !== null && (
        <>
          <ProblemsBanner controller={controller} />
          <HomePanel controller={controller} locked={locked} />
          <FilesPanel controller={controller} locked={locked} />
          <DocumentsPanel controller={controller} locked={locked} />
          <WebPanel controller={controller} locked={locked} />
          <DatabasesPanel controller={controller} locked={locked} />
          <ProgramsPanel controller={controller} />
        </>
      )}
    </>
  );
}
