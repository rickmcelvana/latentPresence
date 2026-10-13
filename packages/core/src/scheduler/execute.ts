import type { CancellationSignal, LLMProvider, Schedule } from '@latentpresence/protocol';
import { withLocalTools, type LocalTool } from '../self/tools';

/**
 * Running one firing of a schedule (P6-T07, ADR-56) through the normal agent loop — her model
 * and `withLocalTools` — with **only the tools the schedule allows**: a job asked to summarise a
 * folder may read it, and nothing else. A schedule with no task prompt is a reminder: its
 * description is the message, and no model is asked.
 */

export interface ScheduleOutcome {
  readonly ok: boolean;
  /** What to tell them, in her words; empty when there is nothing to say. */
  readonly summary: string;
  readonly error: string | null;
}

export type ScheduleExecutor = (schedule: Schedule, scheduledFor: Date, signal?: CancellationSignal) => Promise<ScheduleOutcome>;

export interface AgentExecutorOptions {
  readonly llm: LLMProvider;
  readonly modelId: string;
  /** Who is doing it: the persona's name and summary. */
  readonly character: { readonly name: string; readonly summary?: string | null };
  /** Every tool she has; the schedule's `allowedTools` picks from these by name. */
  readonly tools: () => readonly LocalTool[];
}

/** In the system prompt, so a fake or a recording can tell a scheduled job from a conversation. */
export const SCHEDULE_MARKER = 'something they asked you to do on a schedule';

export function scheduleSystem(character: AgentExecutorOptions['character'], schedule: Schedule, scheduledFor: Date): string {
  return [
    `You are ${character.name}. You are doing ${SCHEDULE_MARKER}: "${schedule.description}", due ${scheduledFor.toISOString()}.`,
    ...(character.summary == null || character.summary === '' ? [] : [`Who you are: ${character.summary}`]),
    schedule.allowedTools.length === 0 ? 'You have no tools for this; work from what you know.' : 'Use only the tools you are given, and only as the task needs.',
    'Then write what you would tell them about it: one to three sentences, plain words, no tags or markup, as you would say it out loud. If there is nothing worth saying, write nothing.',
  ].join('\n');
}

/** Inline tags (`[emote:joy]`) and stray markup are for a live answer, not a message kept for later. */
function plain(text: string): string {
  return text
    .replaceAll(/\[[a-z]+:[^\]]*\]/giu, '')
    .replaceAll(/\s+/gu, ' ')
    .trim();
}

export function agentExecutor(options: AgentExecutorOptions): ScheduleExecutor {
  return async (schedule, scheduledFor, signal) => {
    if (schedule.taskPrompt.trim() === '') return { ok: true, summary: schedule.description, error: null };
    const allowed = (): LocalTool[] => options.tools().filter((tool) => schedule.allowedTools.includes(tool.definition.name));
    const llm = withLocalTools(options.llm, allowed);
    let text = '';
    try {
      for await (const chunk of llm.stream(
        {
          modelId: options.modelId,
          messages: [
            { role: 'system', content: scheduleSystem(options.character, schedule, scheduledFor) },
            { role: 'user', content: schedule.taskPrompt },
          ],
          tools: [],
          temperature: null,
          maxOutputTokens: null,
        },
        signal === undefined ? {} : { signal },
      )) {
        if (chunk.type === 'text-delta') text += chunk.text;
        if (chunk.type === 'finish' && chunk.reason === 'error') throw new Error('the model stream ended in error');
      }
    } catch (error) {
      return { ok: false, summary: '', error: error instanceof Error ? error.message : String(error) };
    }
    return { ok: true, summary: plain(text), error: null };
  };
}
