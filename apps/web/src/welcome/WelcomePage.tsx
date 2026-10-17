import type { ReactElement } from 'react';
import { Wizard, type WizardProps } from './Wizard';

/** `/welcome` (P8-T02), and `/` until setup has been finished or skipped. Lazy-loaded from `App.tsx`. */
export function WelcomePage(props: WizardProps = {}): ReactElement {
  return (
    <main className="welcome-page">
      <Wizard {...props} />
    </main>
  );
}
