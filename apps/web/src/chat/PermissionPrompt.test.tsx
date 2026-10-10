import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PermissionPrompts, type PermissionOutcome } from '@latentpresence/core';
import type { JsonObject } from '@latentpresence/protocol';
import { PermissionPrompt } from './PermissionPrompt';

afterEach(cleanup);

function prompts(): PermissionPrompts {
  return new PermissionPrompts({ timers: { setTimeout: () => 0, clearTimeout: () => undefined } });
}

function ask(gate: PermissionPrompts, tool: string, args: JsonObject = { q: 'vitest' }, changed = false): Promise<PermissionOutcome> {
  return gate.ask({ serverId: 'srv-1', serverName: 'DeepWiki', tool, description: `Does ${tool}.`, args, changed });
}

describe('PermissionPrompt', () => {
  it('renders nothing while nothing waits', () => {
    const { container } = render(<PermissionPrompt characterName="Alice" prompts={prompts()} />);
    expect(container.firstChild).toBeNull();
  });

  it('names who wants what, with its description and its arguments one to a line', async () => {
    const gate = prompts();
    render(<PermissionPrompt characterName="Alice" prompts={gate} />);
    act(() => void ask(gate, 'search', { q: 'vitest', limit: 3, filter: { lang: 'ts' } }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('Alice wants to use DeepWiki · search');
    expect(dialog.textContent).toContain('Does search.');
    expect(dialog.querySelector('pre')?.textContent).toBe('q: vitest\nlimit: 3\nfilter: {\n  "lang": "ts"\n}');
    expect(dialog.getAttribute('aria-labelledby')).not.toBeNull();
    expect(dialog.getAttribute('aria-describedby')).not.toBeNull();
    expect(screen.queryByText(/more waiting/)).toBeNull();
    expect(screen.queryByText(/has changed since you allowed it/)).toBeNull();
  });

  it('shows a query as it was written — the preview before it runs (P5-T05)', async () => {
    const gate = prompts();
    render(<PermissionPrompt characterName="Alice" prompts={gate} />);
    act(() => void ask(gate, 'query', { sql: "SELECT name\nFROM herbs\nWHERE note = 'a \"b\"'" }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.querySelector('pre')?.textContent).toBe("sql: SELECT name\nFROM herbs\nWHERE note = 'a \"b\"'");
  });

  it.each([
    ['Allow once', 'once'],
    ['Always allow', 'always'],
    ['Deny', 'deny'],
  ] as const)('%s answers the ask', async (button, decision) => {
    const gate = prompts();
    render(<PermissionPrompt characterName="Alice" prompts={gate} />);
    let outcome: Promise<PermissionOutcome> | undefined;
    act(() => {
      outcome = ask(gate, 'search');
    });
    fireEvent.click(await screen.findByRole('button', { name: button }));
    await expect(outcome).resolves.toEqual({ decision });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('shows the oldest ask, says how many more wait, and moves on to the next', async () => {
    const gate = prompts();
    render(<PermissionPrompt characterName="Alice" prompts={gate} />);
    act(() => {
      void ask(gate, 'first');
      void ask(gate, 'second');
      void ask(gate, 'third');
    });
    expect((await screen.findByRole('alertdialog')).textContent).toContain('DeepWiki · first');
    expect(screen.getByText('+2 more waiting')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(screen.getByRole('alertdialog').textContent).toContain('DeepWiki · second');
    expect(screen.getByText('+1 more waiting')).toBeTruthy();
  });

  it('warns when the tool has changed since it was allowed', async () => {
    const gate = prompts();
    render(<PermissionPrompt characterName="Alice" prompts={gate} />);
    act(() => void ask(gate, 'search', {}, true));
    expect(await screen.findByText('This tool has changed since you allowed it.')).toBeTruthy();
  });

  it('takes focus for Allow once, but never from the text box', async () => {
    const gate = prompts();
    render(
      <>
        <textarea aria-label="draft" />
        <PermissionPrompt characterName="Alice" prompts={gate} />
      </>,
    );
    const draft = screen.getByLabelText('draft');
    draft.focus();
    act(() => void ask(gate, 'first'));
    await screen.findByRole('alertdialog');
    expect(document.activeElement).toBe(draft);

    draft.blur();
    act(() => void ask(gate, 'second'));
    // The first is still the one showing; answering it brings the second up, and focus is free.
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Allow once' }));
  });

  it('goes when the ask ends without an answer', async () => {
    const gate = prompts();
    render(<PermissionPrompt characterName="Alice" prompts={gate} />);
    const controller = new AbortController();
    act(() => void gate.ask({ serverId: 's', serverName: 'DeepWiki', tool: 'search', description: '', args: {}, changed: false }, controller.signal));
    await screen.findByRole('alertdialog');
    act(() => controller.abort());
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
