import { describe, expect, it } from 'vitest';
import {
  LlmCapabilitiesSchema,
  ModelDescriptorSchema,
  ProviderDescriptorSchema,
  TtsCapabilitiesSchema,
} from './capabilities';

const llmCapabilities = {
  streaming: true,
  toolCalls: true,
  structuredOutput: true,
  thinking: false,
  promptCaching: false,
  vision: false,
  contextLength: 131_072,
};

describe('LlmCapabilitiesSchema', () => {
  it('lets a provider say it does not know its context length', () => {
    // Several OpenAI-compatible endpoints do not report one. null says "unknown";
    // a default number here would be a guess the token budget then trusted.
    expect(LlmCapabilitiesSchema.parse({ ...llmCapabilities, contextLength: null }).contextLength)
      .toBeNull();
    expect(LlmCapabilitiesSchema.safeParse({ ...llmCapabilities, contextLength: 0 }).success)
      .toBe(false);
  });

  it('requires every flag, so an unset one cannot read as false', () => {
    // A missing flag defaulting to false would silently disable tool calling on a
    // provider that supports it, and the failure would look like a model problem.
    const { toolCalls: _dropped, ...missingFlag } = llmCapabilities;
    expect(LlmCapabilitiesSchema.safeParse(missingFlag).success).toBe(false);
  });
});

describe('TtsCapabilitiesSchema', () => {
  it('carries the sample rate the audio queue has to resample from', () => {
    const capabilities = {
      streaming: true,
      wordTimestamps: false,
      emotionHints: false,
      styleTags: false,
      runsInBrowser: true,
      sampleRate: 24_000,
    };
    expect(TtsCapabilitiesSchema.parse(capabilities)).toEqual(capabilities);
    expect(TtsCapabilitiesSchema.safeParse({ ...capabilities, sampleRate: 0 }).success).toBe(false);
  });
});

describe('ModelDescriptorSchema', () => {
  it('has everything the consent screen must show before a download', () => {
    // The hard rule is that nothing downloads without size, licence and source in
    // front of the user (ADR-09). A descriptor missing one cannot satisfy it.
    const model = {
      id: 'onnx-community/moonshine-tiny-ONNX',
      label: 'Moonshine tiny',
      sizeBytes: 52_000_000,
      licence: 'MIT',
      sourceUrl: 'https://huggingface.co/onnx-community/moonshine-tiny-ONNX',
    };
    expect(ModelDescriptorSchema.parse(model)).toEqual(model);

    for (const field of ['sizeBytes', 'licence', 'sourceUrl'] as const) {
      const { [field]: _dropped, ...incomplete } = model;
      expect(ModelDescriptorSchema.safeParse(incomplete).success).toBe(false);
    }
    expect(ModelDescriptorSchema.safeParse({ ...model, sourceUrl: 'somewhere' }).success)
      .toBe(false);
  });
});

describe('ProviderDescriptorSchema', () => {
  it('pairs each kind with its own capability object', () => {
    const descriptor = {
      kind: 'llm',
      id: 'ollama',
      label: 'Ollama',
      requiresDownload: [],
      capabilities: llmCapabilities,
    };
    expect(ProviderDescriptorSchema.parse(descriptor)).toEqual(descriptor);
  });

  it('rejects capabilities belonging to another kind', () => {
    // Without the discriminator doing real work, a settings page could render TTS
    // controls for an LLM and nothing would complain until runtime.
    const out = ProviderDescriptorSchema.safeParse({
      kind: 'tts',
      id: 'kokoro',
      label: 'Kokoro',
      requiresDownload: [],
      capabilities: llmCapabilities,
    });
    expect(out.success).toBe(false);
  });

  it('makes a browser provider declare what it would download', () => {
    const out = ProviderDescriptorSchema.safeParse({
      kind: 'stt',
      id: 'moonshine-browser',
      label: 'Moonshine (browser)',
      capabilities: {
        streaming: true,
        wordTimestamps: false,
        languageDetection: false,
        runsInBrowser: true,
        languages: ['en'],
      },
    });
    expect(out.success).toBe(false);
    expect(out.error?.issues[0]?.path).toEqual(['requiresDownload']);
  });
});
