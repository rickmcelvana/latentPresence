import type { ReactElement } from 'react';
import { desktopShell } from '../desktop/desktop';

/**
 * Where a pasted key ends up, said truthfully for where the page is running (R-56, P8-T02):
 * in the desktop app keys go to Windows Credential Manager (`KeychainVault`), in a browser to
 * an encrypted store in that browser's storage.
 */
export function VaultNote(): ReactElement {
  return (
    <p className="panel-note settings-vault-note">
      {desktopShell() === null
        ? "Keys are encrypted in this browser's storage. Anything running on this page, or anyone using this browser profile, can still use them."
        : "Keys are kept in Windows Credential Manager, not in this app's storage."}
    </p>
  );
}
