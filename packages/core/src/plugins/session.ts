import type { JsonValue, PromptContext } from '@latentpresence/protocol';
import type { LocalTool } from '../self/tools';
import type { PermissionPrompts } from '../tools/gate';
import type { CheckedPlugin } from './check';
import type { PluginLocalTool } from './runtime';

/**
 * A character's plugins for one conversation, loaded when needed (P10-T04, ADR-72 item 4).
 *
 * **Loaded directly by default** (ADR-72 item 4, as amended by P10-T04's measurement): its instructions
 * and tools are in every request. A plugin the person sets to "load only when needed" costs one line
 * in the prompt and a place in the one shared tool, `use_plugin`, until she uses it. Calling it brings the plugin's instructions (in its result now, in the prompt
 * from the next turn) and its tools (from the next round of the same answer, since the tool loop
 * reads the list again). Measured on 2026-11-06, loading when needed was about four times slower and
 * qwen3.5:9b used the plugin's tool 6 times in 16 (`docs/runs/P10-T04-lazy.md`), while offering up to 64
 * tools directly cost no model any accuracy (`docs/runs/P10-T04-tools.md`): it is for saving tokens.
 */

export const USE_PLUGIN_TOOL = 'use_plugin';

export interface EnabledPlugin {
  readonly plugin: CheckedPlugin;
  readonly tools: readonly PluginLocalTool[];
  /** In use from the start: its instructions and tools in every request (the person chose this). */
  readonly always: boolean;
}

export type PluginPromptContext = NonNullable<PromptContext['plugins']>;

export class PluginSession {
  private readonly enabled: readonly EnabledPlugin[];
  private readonly used = new Set<string>();

  constructor(enabled: readonly EnabledPlugin[]) {
    this.enabled = enabled;
    for (const entry of enabled) if (entry.always) this.used.add(entry.plugin.manifest.id);
  }

  /** Ids in use, in the order they were enabled. */
  inUse(): readonly string[] {
    return this.enabled.map((entry) => entry.plugin.manifest.id).filter((id) => this.used.has(id));
  }

  /** `use_plugin` while any plugin is unused, then the tools of every plugin in use. Read per round. */
  tools(): LocalTool[] {
    const unused = this.enabled.filter((entry) => !this.used.has(entry.plugin.manifest.id));
    return [...(unused.length === 0 ? [] : [this.useTool(unused)]), ...this.enabled.filter((entry) => this.used.has(entry.plugin.manifest.id)).flatMap((entry) => entry.tools)];
  }

  /** The prompt's part: null with nothing enabled, which leaves the prompt as it was. */
  promptContext(): PluginPromptContext | null {
    if (this.enabled.length === 0) return null;
    return {
      available: this.enabled.filter((entry) => !this.used.has(entry.plugin.manifest.id)).map(({ plugin }) => ({ id: plugin.manifest.id, name: plugin.manifest.name, summary: plugin.manifest.summary })),
      inUse: this.enabled.filter((entry) => this.used.has(entry.plugin.manifest.id)).map(({ plugin }) => ({ id: plugin.manifest.id, name: plugin.manifest.name, instructions: plugin.instructions })),
    };
  }

  private useTool(unused: readonly EnabledPlugin[]): LocalTool {
    return {
      definition: {
        name: USE_PLUGIN_TOOL,
        description: 'Start using one of your plugins, before doing anything it is for. Its instructions come back, and its own tools are yours from then on.',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string', enum: unused.map((entry) => entry.plugin.manifest.id), description: 'The plugin to use, by its id.' } },
          required: ['id'],
        },
      },
      run: async (args): Promise<JsonValue> => {
        const id = typeof args['id'] === 'string' ? args['id'].trim() : '';
        const entry = this.enabled.find((candidate) => candidate.plugin.manifest.id === id || candidate.plugin.manifest.name.toLowerCase() === id.toLowerCase());
        if (entry === undefined) {
          return { error: `You have no plugin "${id}". Yours are: ${this.enabled.map((candidate) => candidate.plugin.manifest.id).join(', ')}.` };
        }
        const already = this.used.has(entry.plugin.manifest.id);
        this.used.add(entry.plugin.manifest.id);
        return {
          using: entry.plugin.manifest.name,
          ...(already ? { note: 'It was already in use.' } : {}),
          tools: entry.tools.map((tool) => tool.definition.name),
          instructions: entry.plugin.instructions,
        };
      },
    };
  }
}

/** The prompt's plugin section (ADR-72 item 4): what she can start using, then what is in use. */
export function renderPlugins(plugins: PluginPromptContext): string[] {
  if (plugins.available.length === 0 && plugins.inUse.length === 0) return [];
  return [
    'YOUR PLUGINS',
    '- Abilities the person added for you. Their tools are not invented by you: use them as they say.',
    ...(plugins.available.length === 0
      ? []
      : [
          '- To use one of these, call use_plugin with its id first; its own tools come after that.',
          '  Use one only when what they ask is what it is for.',
          ...plugins.available.map((plugin) => `- ${plugin.id}: ${plugin.summary}`),
        ]),
    ...plugins.inUse.flatMap((plugin) => ['', `PLUGIN IN USE: ${plugin.name.toUpperCase()}`, plugin.instructions.trim()]),
    '',
  ];
}

/**
 * A plugin tool whose manifest says `policy: 'ask'`, asked about first through the same gate as an
 * outside tool (ADR-42): denied, it returns a sentence and runs nothing. `auto` tools pass as they are.
 */
export function askFirst(tool: PluginLocalTool, pluginName: string, prompts: PermissionPrompts): PluginLocalTool {
  if (tool.policy !== 'ask') return tool;
  return {
    ...tool,
    run: async (args, context) => {
      const outcome = await prompts.ask(
        { serverId: `plugin:${tool.pluginId}`, serverName: pluginName, tool: tool.definition.name, description: tool.definition.description, args: { ...args }, changed: false, always: null },
        context.signal,
      );
      if (outcome.decision === 'deny') return { error: `The person said no to ${pluginName}'s ${tool.definition.name} this time. Do not try it again for this; carry on without it.` };
      return tool.run(args, context);
    },
  };
}

/**
 * What a character's plugins cost in every request (ADR-72 item 4), and when to say so. The limits
 * are measured, not guessed (`docs/runs/P10-T04-tools.md`); the counts are estimates (characters / 4)
 * and are said as estimates. A warning is advice: nothing is refused.
 */
export const PLUGIN_BUDGET = {
  /**
   * Tools in every request from plugins that load directly. 64 is as far as it was measured: qwen3.5:9b,
   * gemma4:12b and glm-5.2 chose no worse at 64 than at 8 (`docs/runs/P10-T04-tools.md`). Past it is unmeasured.
   */
  alwaysTools: 64,
  /** Tokens in every request from plugins: about twice Alice's own prompt (940 tokens, 2026-11-06). */
  promptTokens: 2_000,
} as const;

export interface PluginCost {
  readonly name: string;
  readonly tools: number;
  readonly promptTokens: { readonly idle: number; readonly used: number };
  readonly always: boolean;
}

export interface PluginBudget {
  /** Tokens in every request: each unused plugin's line, each always-loaded plugin's instructions and tools. */
  readonly everyRequest: number;
  /** Tools in every request: `use_plugin` while any is unused, and the always-loaded plugins'. */
  readonly tools: number;
  readonly warnings: readonly string[];
}

export function pluginBudget(costs: readonly PluginCost[], characterName: string): PluginBudget {
  const unused = costs.filter((cost) => !cost.always);
  const always = costs.filter((cost) => cost.always);
  const everyRequest = unused.reduce((sum, cost) => sum + cost.promptTokens.idle, 0) + always.reduce((sum, cost) => sum + cost.promptTokens.idle + cost.promptTokens.used, 0);
  const alwaysTools = always.reduce((sum, cost) => sum + cost.tools, 0);
  const tools = alwaysTools + (unused.length > 0 ? 1 : 0);
  const warnings: string[] = [];
  if (alwaysTools > PLUGIN_BUDGET.alwaysTools) {
    warnings.push(
      `${characterName}'s plugins offer ${alwaysTools} tools in every request, more than the ${PLUGIN_BUDGET.alwaysTools} the app was measured with. Setting some to load only when needed keeps the list shorter.`,
    );
  }
  if (everyRequest > PLUGIN_BUDGET.promptTokens) {
    warnings.push(
      `${characterName}'s plugins add about ${everyRequest} tokens to every request (an estimate), more than twice her own prompt. Setting some to load only when needed saves most of that, at the cost of a slower first use.`,
    );
  }
  return { everyRequest, tools, warnings };
}
