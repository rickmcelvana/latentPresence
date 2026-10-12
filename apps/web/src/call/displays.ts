import type { ScreenContent, WhiteboardContent } from '@latentpresence/avatar';
import type { TranscriptLine } from '@latentpresence/core';
import type { PlanDocument } from '@latentpresence/protocol';
import type { CitationSource } from '../transcript/TranscriptPanel';

/**
 * What the room's whiteboard and screen show (P5-T08, ADR-49), worked out from what the page
 * already has: her plans and the sources of her latest answer. Pure — `ChatPage` calls these
 * and hands the result to `CallStage`. Nothing new is stored or sent.
 */

/** The plan on the whiteboard: the one in focus, else the newest that is not archived. */
export function pickPlan(plans: readonly PlanDocument[], focusId: string | null): PlanDocument | null {
  const focused = focusId === null ? undefined : plans.find((plan) => plan.id === focusId);
  if (focused !== undefined) return focused;
  const open = plans.filter((plan) => plan.status !== 'archived');
  let newest: PlanDocument | null = null;
  for (const plan of open) {
    if (newest === null || Date.parse(plan.updatedAt) > Date.parse(newest.updatedAt)) newest = plan;
  }
  return newest;
}

/** A plan as the whiteboard shows it: phases as headings, tasks ticked or not, dropped ones left out. */
export function planToWhiteboard(plan: PlanDocument): WhiteboardContent {
  return {
    title: plan.title,
    lines: plan.phases.flatMap((phase) => [
      { text: phase.title, kind: 'heading' as const, done: false },
      ...phase.tasks
        .filter((task) => task.status !== 'dropped')
        .map((task) => ({ text: task.title, kind: 'task' as const, done: task.status === 'done' })),
    ]),
  };
}

/** The sources as the screen shows them: title, where (a page, a site), and what they said. Null with none. */
export function sourcesToScreen(sources: readonly CitationSource[]): ScreenContent | null {
  if (sources.length === 0) return null;
  return {
    heading: 'Sources',
    items: sources.map((source) => ({ title: source.title, where: source.locator, text: source.text })),
  };
}

/** The sources her latest answer that cited any cited; unknown refs are skipped. */
export function latestCitedSources(lines: readonly TranscriptLine[], lookup: (ref: string) => CitationSource | undefined): CitationSource[] {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line?.kind !== 'assistant' || line.citations.length === 0) continue;
    return line.citations.flatMap((ref) => lookup(ref) ?? []);
  }
  return [];
}
