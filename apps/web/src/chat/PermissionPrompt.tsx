import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import type { ReactElement } from 'react';
import type { PermissionPrompts } from '@latentpresence/core';
import type { JsonObject } from '@latentpresence/protocol';

/**
 * The card that asks before a tool reaches outside (P5-T01, ADR-42). It shows the oldest ask in
 * the gate's queue and says how many more wait behind it; each button is the person's answer.
 *
 * It appears mid-conversation, often while they are typing the next message, so focus moves to
 * the safe-looking first button only when it is not already in a text field.
 */
export interface PermissionPromptProps {
  readonly prompts: PermissionPrompts;
  readonly characterName: string;
}

/**
 * Arguments one to a line, a string as it was written: a database query (P5-T05, ADR-46) is
 * read here before it runs, and JSON would show its line breaks as `\n` and its quotes escaped.
 */
export function shownArguments(args: JsonObject): string {
  const lines = Object.entries(args).map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`);
  return lines.length === 0 ? '(nothing)' : lines.join('\n');
}

function typing(): boolean {
  const active = document.activeElement;
  return active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement || (active instanceof HTMLElement && active.isContentEditable);
}

export function PermissionPrompt({ prompts, characterName }: PermissionPromptProps): ReactElement | null {
  const subscribe = useCallback((listener: () => void) => prompts.subscribe(listener), [prompts]);
  const snapshot = useCallback(() => prompts.snapshot(), [prompts]);
  const waiting = useSyncExternalStore(subscribe, snapshot);
  const current = waiting[0];
  const currentId = current?.id;
  const allowOnce = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (currentId !== undefined && !typing()) allowOnce.current?.focus();
  }, [currentId]);

  if (current === undefined) return null;
  const titleId = `permission-title-${current.id}`;
  const detailId = `permission-detail-${current.id}`;
  const more = waiting.length - 1;
  return (
    <div aria-describedby={detailId} aria-labelledby={titleId} className="call-permission-card panel" role="alertdialog">
      <p className="permission-title" id={titleId}>
        {characterName} wants to use <strong>{current.serverName}</strong> · {current.tool}
      </p>
      <div id={detailId}>
        {current.description !== '' && <p className="permission-description">{current.description}</p>}
        <pre className="permission-args">{shownArguments(current.args)}</pre>
      </div>
      {current.changed && <p className="settings-status settings-status-warn">This tool has changed since you allowed it.</p>}
      <div className="permission-actions">
        <button className="btn btn-primary" onClick={() => prompts.answer(current.id, 'once')} ref={allowOnce} type="button">
          Allow once
        </button>
        <button className="btn" onClick={() => prompts.answer(current.id, 'always')} type="button">
          Always allow
        </button>
        <button className="btn btn-ghost" onClick={() => prompts.answer(current.id, 'deny')} type="button">
          Deny
        </button>
        {more > 0 && <span className="permission-more">+{more} more waiting</span>}
      </div>
    </div>
  );
}
