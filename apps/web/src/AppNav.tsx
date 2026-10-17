import type { ReactElement } from 'react';

/** The pages a person moves between. Paths match `App.tsx`'s constants, written out here so this
 * small bar does not import the router module (and with it every lazy page). */
const LINKS = [
  { href: '/chat', label: 'Chat' },
  { href: '/settings', label: 'Settings' },
  { href: '/welcome', label: 'Setup' },
] as const;

export interface AppNavProps {
  /** The page this bar sits on, marked `aria-current`. */
  readonly current: (typeof LINKS)[number]['href'];
}

/**
 * The bar across the top of a full page (Rick, 2026-10-17): Settings was a long page with no way
 * out but the browser's Back — and the desktop app has no Back button at all. The name goes to
 * the conversation, as an app's name usually goes home. It stays at the top while the page scrolls.
 */
export function AppNav({ current }: AppNavProps): ReactElement {
  return (
    <nav aria-label="Main" className="app-nav">
      <a className="app-nav-brand" href="/chat">
        latentPresence
      </a>
      <ul className="app-nav-links">
        {LINKS.map((link) => (
          <li key={link.href}>
            <a aria-current={link.href === current ? 'page' : undefined} className="app-nav-link" href={link.href}>
              {link.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
