import type { CancellationSignal, LLMProvider, LlmModel, LlmRequest, LlmStreamChunk } from '@latentpresence/protocol';
import type { SettingsDeps } from '../settings/deps';
import { resolveTransport } from '../settings/connection';
import { buildLlmProvider } from '../settings/llm-endpoint';
import { llmKeyRef } from '../settings/settings';

/**
 * The provider `/chat` streams against (P1-T11), built exactly the way
 * `LanguageModelSection.sendTestMessage` builds one — **except** the key and the
 * transport are resolved fresh on every call to `stream()`, not once when the page
 * loads, so a key saved in another tab, or a companion started after the page opened,
 * is picked up on the next message rather than requiring a reload.
 *
 * A `relay` endpoint whose companion is not answering throws the same text
 * `resolveTransport` produced; `ChatSession` already turns a thrown stream into an
 * `error` event with that message (`scope: 'llm'`), which the transcript shows as a
 * notice — no separate dispatch needed here.
 */
export interface ChatLlmOptions {
  readonly endpointId: string;
  readonly baseUrl: string;
  readonly companionUrl: string;
  readonly deps: SettingsDeps;
}

export function chatLlmProvider({ endpointId, baseUrl, companionUrl, deps }: ChatLlmOptions): LLMProvider {
  return {
    id: endpointId,
    async listModels(): Promise<LlmModel[]> {
      return [];
    },
    async *stream(request: LlmRequest, options?: { signal?: CancellationSignal }): AsyncIterable<LlmStreamChunk> {
      const apiKey = await deps.vault.loadKey(llmKeyRef(endpointId));
      const transport = await resolveTransport({ endpointId, companionUrl, origin: deps.origin, fetch: deps.fetch, probe: deps.probe });
      if (!transport.ok) {
        // The summary alone ("…go through the companion on this computer") leaves out how to
        // start it; the first step says. /settings shows the same words.
        const start = transport.result.help?.steps[0];
        throw new Error(start === undefined ? transport.result.text : `${transport.result.text} ${start}.`);
      }
      const provider = buildLlmProvider(endpointId, baseUrl, apiKey, transport.fetch);
      yield* provider.stream(request, options);
    },
  };
}
