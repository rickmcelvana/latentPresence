import { useEffect } from 'react';
import type { ReactElement } from 'react';
import type { CompanionController } from '../settings/companion-config-state';
import { LoadState, ProblemsBanner } from '../settings/CompanionSettings';
import { DocumentsPanel, FilesPanel, HomePanel } from '../settings/CompanionPanels';

export interface CompanionStepProps {
  /** The wizard owns the controller, so its summary can say what was connected. */
  readonly controller: CompanionController;
}

/** What was connected, for the summary: empty when nothing was. */
export function connectedSummary(controller: CompanionController): string[] {
  const config = controller.config;
  if (config === null) return [];
  const parts: string[] = [];
  if (config.home !== null) parts.push('Home Assistant');
  if (config.roots.length > 0) parts.push(config.roots.length === 1 ? '1 folder she can read' : `${config.roots.length} folders she can read`);
  if (config.folders.length > 0) parts.push(config.folders.length === 1 ? '1 folder of documents' : `${config.folders.length} folders of documents`);
  return parts;
}

/**
 * Step 5, in the desktop app only (P8-T06): Home Assistant, folders of notes and folders of
 * documents. Optional, and each is the same panel Settings shows. Web search, databases and
 * programs are left to Settings. Adding any of them turns on the switch it needs.
 */
export function CompanionStep({ controller }: CompanionStepProps): ReactElement {
  const { load } = controller;
  useEffect(() => {
    load();
  }, [load]);

  const locked = (controller.config?.problems.length ?? 0) > 0;
  return (
    <>
      <p className="welcome-lead">
        She can look after your home, read your notes and search your documents. All of it is optional, and each part can be set up later in Settings, under
        On this computer.
      </p>
      <p className="field-hint">Changes restart the companion; her tools from it are back in a few seconds.</p>
      <LoadState controller={controller} />
      {controller.config !== null && (
        <>
          <ProblemsBanner controller={controller} />
          <HomePanel controller={controller} locked={locked} />
          <FilesPanel controller={controller} locked={locked} />
          <DocumentsPanel controller={controller} locked={locked} />
        </>
      )}
    </>
  );
}
