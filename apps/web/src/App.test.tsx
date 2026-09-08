import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@latentpresence/protocol';
import { App } from './App';

afterEach(cleanup);

describe('App', () => {
  it('renders the boot screen with the protocol version the app is linked against', () => {
    // Fails if React, jsdom, or workspace package resolution from apps/web breaks —
    // the three things the scaffold has to keep working for every later task.
    const { container } = render(<App />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('latentPresence');
    expect(container.textContent).toContain(`protocol v${PROTOCOL_VERSION}`);
    expect(container.textContent).toContain('@latentpresence/core');
  });
});
