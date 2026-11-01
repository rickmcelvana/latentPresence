import { render } from '@testing-library/react';
import { expect, it } from 'vitest';
import { expectAccessible } from './axe';
it('catches a nameless button', async () => {
  const { container } = render(<div><button /><img src="x" /></div>);
  await expect(expectAccessible(container)).rejects.toThrow(/button-name/);
});
