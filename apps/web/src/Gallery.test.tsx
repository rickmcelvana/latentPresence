import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App, GALLERY_PATH } from './App';
import { Gallery } from './Gallery';

afterEach(cleanup);

/**
 * The gallery is what a person clicks through to sign off the design system, so what
 * these tests guard is coverage: a primitive that quietly stops being rendered is a
 * primitive nobody looks at again, and `theme.test.ts` would keep passing because the
 * rule is still there.
 */
const EVERY_PRIMITIVE_STATE = [
  '.btn',
  '.btn-primary',
  '.btn-ghost',
  '.btn-danger',
  '.btn-sm',
  '.btn:disabled',
  '.panel',
  '.panel-header',
  '.panel-title',
  '.panel-note',
  '.field',
  '.field-label',
  '.field-hint',
  '.field-error',
  '.input',
  '.input:disabled',
  '.input[aria-invalid="true"]',
  '.textarea',
  '.select',
  '.pill',
  '.pill-accent',
  '.pill-ok',
  '.pill-warn',
  '.pill-danger',
  '.gallery-swatch-chip',
];

describe('Gallery', () => {
  it('renders every primitive in every state', () => {
    const { container } = render(<Gallery />);
    for (const selector of EVERY_PRIMITIVE_STATE) {
      expect(container.querySelector(selector), selector).not.toBeNull();
    }
  });

  it('shows a swatch for each token so a palette change is visible', () => {
    const { container } = render(<Gallery />);
    expect(container.querySelectorAll('.gallery-swatch').length).toBe(14);
  });

  it('opens and closes the drawer, which is the only primitive with a state', () => {
    const { container } = render(<Gallery />);
    expect(container.querySelector('.drawer')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Open drawer' }));
    expect(container.querySelector('.drawer')).not.toBeNull();
    expect(container.querySelector('.drawer-scrim')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Close drawer' }));
    expect(container.querySelector('.drawer')).toBeNull();
  });

  it('closes the drawer on Escape from anywhere, not only from inside it', () => {
    // A keydown handler on the panel itself only fires once focus is already in the
    // drawer, which is exactly when the user least needs a way out.
    const { container } = render(<Gallery />);
    fireEvent.click(screen.getByRole('button', { name: 'Open drawer' }));
    expect(container.querySelector('.drawer')).not.toBeNull();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(container.querySelector('.drawer')).toBeNull();
  });
});

describe('App routing', () => {
  it('serves the gallery on its dev path and the boot screen everywhere else', () => {
    // The gallery is a development surface; App only routes to it under import.meta.env.DEV,
    // so it never reaches app.latentpresence.com.
    // Queried by name, not by being the only h1: the typography specimen renders a
    // real h1 of its own, which is the point of a specimen.
    render(<App path={GALLERY_PATH} />);
    expect(screen.getByRole('heading', { name: 'Design system' })).toBeDefined();
    expect(screen.queryByText(/Scaffold online/)).toBeNull();
    cleanup();

    render(<App path="/" />);
    expect(screen.getByRole('heading', { name: 'latentPresence' })).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'Design system' })).toBeNull();
  });
});
