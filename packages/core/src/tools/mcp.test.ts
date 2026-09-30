import type { JsonObject, LLMProvider, LlmRequest, LlmStreamChunk, McpCallResult, McpServerClient, McpToolInfo, ToolCall } from '@latentpresence/protocol';
import { describe, expect, it } from 'vitest';
import { withLocalTools } from '../self/tools';
import { PermissionPrompts, toolFingerprint, type ToolGrant, type ToolGrants } from './gate';
import { settle } from '../testing/scripted';
import { ManualTimers, manualSignal } from '../testing/timers';
import { MCP_RESULT_LIMIT, mcpToolName, mcpTools, splitToolName, toolResultOf, type ConnectedToolServer } from './mcp';

const AT = '2026-09-30T12:00:00.000Z';

const READ: McpToolInfo = { name: 'read_wiki_structure', description: 'Get a list of documentation topics.', inputSchema: { type: 'object', properties: { repoName: { type: 'string' } }, required: ['repoName'] }, annotations: null };
const ASK: McpToolInfo = { name: 'ask_question', description: 'Ask about a repository.', inputSchema: { type: 'object' }, annotations: null };

class Server implements McpServerClient {
  readonly serverName = 'DeepWiki';
  readonly instructions = null;
  readonly calls: { name: string; args: JsonObject }[] = [];
  reply: McpCallResult | Error = { isError: false, text: 'Pages: Overview; Core SDK.', structured: null, images: 0 };
  async listTools(): Promise<McpToolInfo[]> {
    return [READ, ASK];
  }
  async callTool(name: string, args: JsonObject): Promise<McpCallResult> {
    this.calls.push({ name, args });
    if (this.reply instanceof Error) throw this.reply;
    return this.reply;
  }
  async close(): Promise<void> {}
}

class Grants implements ToolGrants {
  readonly map = new Map<string, ToolGrant>();
  get(serverId: string, tool: string): ToolGrant | undefined {
    return this.map.get(`${serverId}/${tool}`);
  }
  set(serverId: string, tool: string, grant: ToolGrant): void {
    this.map.set(`${serverId}/${tool}`, grant);
  }
}

function setup(grants = new Grants()) {
  const client = new Server();
  const server: ConnectedToolServer = { id: 'srv-1', label: 'DeepWiki', client, tools: [READ, ASK] };
  const timers = new ManualTimers();
  const prompts = new PermissionPrompts({ timers });
  const tools = mcpTools([server], { grants, prompts });
  const call = (name: string, args: JsonObject = { repoName: 'vercel/ai' }): ToolCall => ({ id: `call-${name}`, name, arguments: args, source: 'llm', requestedAt: AT });
  const run = (name: string, signal?: ReturnType<typeof manualSignal>) => {
    const tool = tools.find((candidate) => candidate.definition.name === name);
    if (tool === undefined) throw new Error(`no ${name}`);
    const c = call(name);
    return tool.run(c.arguments, { call: c, signal });
  };
  return { client, prompts, timers, tools, grants, run };
}


describe('mcpTools (P5-T01, ADR-42)', () => {
  it('names each tool <server>__<tool>, says where it is from, and passes its schema through', () => {
    const { tools } = setup();
    expect(tools.map((tool) => tool.definition.name)).toEqual(['deepwiki__read_wiki_structure', 'deepwiki__ask_question']);
    expect(tools[0]?.definition.description).toBe('(From DeepWiki, outside this computer.) Get a list of documentation topics.');
    expect(tools[0]?.definition.parameters).toEqual(READ.inputSchema);
  });

  it('asks first, and runs the call once allowed', async () => {
    const { client, prompts, run } = setup();
    const result = run('deepwiki__read_wiki_structure');
    await settle();
    expect(prompts.snapshot()).toEqual([expect.objectContaining({ serverId: 'srv-1', serverName: 'DeepWiki', tool: 'read_wiki_structure', args: { repoName: 'vercel/ai' }, changed: false })]);
    expect(client.calls).toEqual([]);
    prompts.answer(prompts.snapshot()[0]?.id ?? '', 'once');
    expect(await result).toEqual({ from: 'DeepWiki', result: 'Pages: Overview; Core SDK.' });
    expect(client.calls).toEqual([{ name: 'read_wiki_structure', args: { repoName: 'vercel/ai' } }]);
  });

  it('remembers "always" with the tool’s fingerprint, and then runs without asking', async () => {
    const { prompts, grants, run } = setup();
    const first = run('deepwiki__read_wiki_structure');
    await settle();
    prompts.answer(prompts.snapshot()[0]?.id ?? '', 'always');
    await first;
    expect(grants.get('srv-1', 'read_wiki_structure')).toEqual({ policy: 'auto', fingerprint: toolFingerprint(READ) });
    expect(await run('deepwiki__read_wiki_structure')).toMatchObject({ from: 'DeepWiki' });
    expect(prompts.snapshot()).toEqual([]);
  });

  it('refuses in words she can pass on: no, no answer, and stopped — and never calls the server', async () => {
    const { client, prompts, timers, run } = setup();
    const no = run('deepwiki__read_wiki_structure');
    await settle();
    prompts.answer(prompts.snapshot()[0]?.id ?? '', 'deny');
    expect(await no).toEqual({ error: expect.stringContaining('said no to using DeepWiki') });
    const late = run('deepwiki__read_wiki_structure');
    await settle();
    timers.fireAll();
    expect(await late).toEqual({ error: expect.stringContaining('did not answer') });
    const signal = manualSignal();
    const stopped = run('deepwiki__read_wiki_structure', signal);
    await settle();
    signal.abort();
    expect(await stopped).toEqual({ error: 'Stopped before it ran.' });
    expect(client.calls).toEqual([]);
  });

  it('does not offer a tool set to never', () => {
    const grants = new Grants();
    grants.set('srv-1', 'ask_question', { policy: 'never', fingerprint: null });
    expect(setup(grants).tools.map((tool) => tool.definition.name)).toEqual(['deepwiki__read_wiki_structure']);
  });

  it('reads the policy again at the call: set to never after the request was built, it does not run', async () => {
    const { client, grants, run } = setup();
    grants.set('srv-1', 'read_wiki_structure', { policy: 'never', fingerprint: null });
    expect(await run('deepwiki__read_wiki_structure')).toEqual({ error: expect.stringContaining('does not allow') });
    expect(client.calls).toEqual([]);
  });

  it('passes a server failure and an unreachable server on as errors', async () => {
    const grants = new Grants();
    grants.set('srv-1', 'read_wiki_structure', { policy: 'auto', fingerprint: toolFingerprint(READ) });
    const { client, run } = setup(grants);
    client.reply = { isError: true, text: 'Repository not found.', structured: null, images: 0 };
    expect(await run('deepwiki__read_wiki_structure')).toEqual({ error: 'DeepWiki said: Repository not found.' });
    client.reply = new Error('Failed to fetch');
    expect(await run('deepwiki__read_wiki_structure')).toEqual({ error: 'DeepWiki could not be reached: Failed to fetch' });
  });

  it('cuts a long result, prefers small structured content, and names images it leaves out', async () => {
    const grants = new Grants();
    grants.set('srv-1', 'read_wiki_structure', { policy: 'auto', fingerprint: toolFingerprint(READ) });
    const { client, run } = setup(grants);
    client.reply = { isError: false, text: 'x'.repeat(MCP_RESULT_LIMIT + 50), structured: null, images: 2 };
    const long = (await run('deepwiki__read_wiki_structure')) as { result: string; note: string };
    expect(long.result).toHaveLength(MCP_RESULT_LIMIT + '… [50 more characters cut]'.length);
    expect(long.note).toContain('2 image(s)');
    client.reply = { isError: false, text: 'ignored', structured: { temperature: 12 }, images: 0 };
    expect(await run('deepwiki__read_wiki_structure')).toEqual({ from: 'DeepWiki', result: { temperature: 12 } });
  });

  it('asks again, marked changed, when a trusted tool changed', async () => {
    const grants = new Grants();
    grants.set('srv-1', 'read_wiki_structure', { policy: 'auto', fingerprint: 'deadbeef' });
    const { prompts, run } = setup(grants);
    void run('deepwiki__read_wiki_structure');
    await settle();
    expect(prompts.snapshot()[0]?.changed).toBe(true);
  });

  it('runs through withLocalTools like any page tool, reporting the start before the ask', async () => {
    const { tools, prompts } = setup();
    const started: string[] = [];
    const call: ToolCall = { id: 'c1', name: 'deepwiki__read_wiki_structure', arguments: { repoName: 'vercel/ai' }, source: 'llm', requestedAt: AT };
    const rounds: LlmStreamChunk[][] = [
      [{ type: 'tool-call', call }, { type: 'finish', reason: 'tool-calls', usage: null }],
      [{ type: 'text-delta', text: 'It covers the core SDK.' }, { type: 'finish', reason: 'stop', usage: null }],
    ];
    const requests: LlmRequest[] = [];
    const llm: LLMProvider = {
      id: 'scripted',
      listModels: async () => [],
      async *stream(request) {
        requests.push(request);
        yield* rounds[requests.length - 1] ?? [];
      },
    };
    const answer = (async () => {
      let text = '';
      for await (const chunk of withLocalTools(llm, () => tools, { onCallStart: (c) => started.push(c.name) }).stream({ modelId: 'm', messages: [{ role: 'user', content: 'What is vercel/ai?' }], tools: [], temperature: null, maxOutputTokens: null })) {
        if (chunk.type === 'text-delta') text += chunk.text;
      }
      return text;
    })();
    await settle();
    expect(started).toEqual(['deepwiki__read_wiki_structure']);
    prompts.answer(prompts.snapshot()[0]?.id ?? '', 'once');
    expect(await answer).toBe('It covers the core SDK.');
    expect(requests[1]?.messages.at(-1)).toEqual({ role: 'tool', callId: 'c1', content: { from: 'DeepWiki', result: 'Pages: Overview; Core SDK.' } });
  });
});

describe('tool names and results', () => {
  it('keeps names to the OpenAI pattern and 64 characters, and splits them back', () => {
    expect(mcpToolName('My Server!', 'get.weather/now')).toBe('my_server__get_weather_now');
    expect(mcpToolName('x'.repeat(40), 'y'.repeat(60))).toHaveLength(64);
    expect(splitToolName('deepwiki__read_wiki_structure')).toEqual({ server: 'deepwiki', tool: 'read_wiki_structure' });
    expect(splitToolName('plan_create')).toEqual({ server: null, tool: 'plan_create' });
  });

  it('makes a result with an error a failed ToolResult', () => {
    const call: ToolCall = { id: 'c', name: 'n', arguments: {}, source: 'llm', requestedAt: AT };
    expect(toolResultOf(call, { error: 'They said no.' }, AT)).toEqual({ ok: false, callId: 'c', error: 'They said no.', finishedAt: AT });
    expect(toolResultOf(call, { from: 'X', result: 'y' }, AT)).toEqual({ ok: true, callId: 'c', value: { from: 'X', result: 'y' }, finishedAt: AT });
  });
});
