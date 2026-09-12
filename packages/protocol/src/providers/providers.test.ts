import { describe, expect, it } from 'vitest';
import { ExpressionWeightsSchema } from '../affect';
import { CharacterSourceSchema, ClipOptionsSchema, VisemeSchema } from '../avatar';
import { LlmMessageSchema, LlmModelSchema, LlmRequestSchema, LlmStreamChunkSchema } from './llm';
import { SttResultSchema } from './stt';
import { TtsRequestSchema, TtsVoiceSchema } from './tts';
import { EmbeddingVectorSchema } from './embedding';

describe('LlmMessageSchema', () => {
  it('keeps tool results tied to the call they answer', () => {
    // A tool message with no callId cannot be matched to its request, and every
    // OpenAI-compatible endpoint rejects the conversation that results.
    const message = { role: 'tool', callId: 'call-1', content: { rows: 2 } };
    expect(LlmMessageSchema.parse(message)).toEqual(message);
    const { callId: _dropped, ...withoutCallId } = message;
    expect(LlmMessageSchema.safeParse(withoutCallId).success).toBe(false);
  });

  it('requires an assistant turn to carry its tool calls explicitly', () => {
    const out = LlmMessageSchema.safeParse({ role: 'assistant', content: 'sure' });
    expect(out.success).toBe(false);
    expect(out.error?.issues[0]?.path).toEqual(['toolCalls']);
  });
});

describe('LlmRequestSchema', () => {
  it('will not send an empty conversation', () => {
    const request = {
      modelId: 'nemotron-3-nano',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      temperature: null,
      maxOutputTokens: null,
    };
    expect(LlmRequestSchema.parse(request)).toEqual(request);
    expect(LlmRequestSchema.safeParse({ ...request, messages: [] }).success).toBe(false);
  });

  it('treats an unset temperature as different from zero', () => {
    // null leaves the backend's default alone; 0 pins it to greedy decoding. Conflating
    // them would quietly change how every model in the app behaves.
    expect(LlmRequestSchema.parse({
      modelId: 'm',
      messages: [{ role: 'user', content: 'x' }],
      tools: [],
      temperature: 0,
      maxOutputTokens: null,
    }).temperature).toBe(0);
  });
});

describe('LlmModelSchema', () => {
  it('permits null capabilities for a discovery that could not enrich', () => {
    // The OpenAI-compatible /v1/models list carries no capability data (latentCreate
    // LLM-SURFACE 11). null is the only truthful answer; a guessed boolean would label
    // an unknown embedding model "can chat".
    const unenriched = {
      id: 'some-model:latest',
      label: 'some-model',
      capabilities: null,
      embeddingOnly: false,
    };
    expect(LlmModelSchema.parse(unenriched)).toEqual(unenriched);

    const enriched = {
      id: 'gemma4:12b',
      label: 'gemma4:12b',
      capabilities: {
        streaming: true,
        toolCalls: true,
        structuredOutput: false,
        thinking: true,
        promptCaching: false,
        vision: true,
        contextLength: 262144,
      },
      embeddingOnly: false,
    };
    expect(LlmModelSchema.parse(enriched).capabilities?.thinking).toBe(true);
  });
});

describe('LlmStreamChunkSchema', () => {
  it('keeps reasoning as its own variant', () => {
    // Reasoning must never be spoken or written to the transcript. Sharing the text
    // variant would put a model's private thinking into the character's mouth.
    const reasoning = LlmStreamChunkSchema.parse({ type: 'reasoning-delta', text: 'hmm' });
    expect(reasoning.type).toBe('reasoning-delta');

    const finish = LlmStreamChunkSchema.parse({
      type: 'finish',
      reason: 'aborted',
      usage: null,
    });
    expect(finish.type).toBe('finish');
    expect(LlmStreamChunkSchema.safeParse({ type: 'finish', reason: 'bored', usage: null }).success)
      .toBe(false);
  });
});

describe('SttResultSchema', () => {
  it('separates partial results from the ones that get written down', () => {
    // Only final results reach the transcript and memory; a missing isFinal would make
    // every partial look final and fill memory with half-sentences.
    const partial = {
      text: 'I was thinking',
      isFinal: false,
      confidence: null,
      language: 'en',
      words: [],
    };
    expect(SttResultSchema.parse(partial)).toEqual(partial);
    const { isFinal: _dropped, ...withoutFlag } = partial;
    expect(SttResultSchema.safeParse(withoutFlag).success).toBe(false);
  });

  it('takes word timings when the provider has them', () => {
    const result = SttResultSchema.parse({
      text: 'hello there',
      isFinal: true,
      confidence: 0.94,
      language: 'en',
      words: [
        { text: 'hello', startMs: 0, endMs: 320 },
        { text: 'there', startMs: 330, endMs: 610 },
      ],
    });
    expect(result.words).toHaveLength(2);
    expect(
      SttResultSchema.safeParse({
        text: 'x',
        isFinal: true,
        confidence: null,
        language: null,
        words: [{ text: 'x', startMs: -1, endMs: 10 }],
      }).success,
    ).toBe(false);
  });
});

describe('TtsRequestSchema', () => {
  it('carries an emotion hint that providers without one may ignore', () => {
    const request = {
      text: 'That is good news.',
      voiceId: 'af_heart',
      speed: 1,
      hint: { label: 'joy', intensity: 0.6, energy: 0.7 },
    };
    expect(TtsRequestSchema.parse(request)).toEqual(request);
    expect(TtsRequestSchema.parse({ ...request, hint: null }).hint).toBeNull();
  });

  it('refuses an empty line and an absurd speed', () => {
    // The splitter should never hand TTS an empty chunk, and a speed of 0 would
    // synthesise silence forever.
    expect(TtsRequestSchema.safeParse({ text: '', voiceId: 'v', speed: 1, hint: null }).success)
      .toBe(false);
    expect(TtsRequestSchema.safeParse({ text: 'x', voiceId: 'v', speed: 0, hint: null }).success)
      .toBe(false);
  });
});

describe('TtsVoiceSchema', () => {
  it('only reports a gender the backend actually stated', () => {
    // "unknown" is a real answer. Guessing from a voice name is how you mislabel people.
    expect(
      TtsVoiceSchema.parse({ id: 'v', label: 'Voice', language: null, gender: 'unknown' }).gender,
    ).toBe('unknown');
    expect(
      TtsVoiceSchema.safeParse({ id: 'v', label: 'Voice', language: null, gender: 'probably male' })
        .success,
    ).toBe(false);
  });
});

describe('EmbeddingVectorSchema', () => {
  it('rejects an empty vector', () => {
    // An empty vector inserts happily and then matches nothing, forever.
    expect(EmbeddingVectorSchema.parse([0.1, 0.2])).toEqual([0.1, 0.2]);
    expect(EmbeddingVectorSchema.safeParse([]).success).toBe(false);
  });
});

describe('avatar', () => {
  it('drives only visemes the renderer has', () => {
    expect(VisemeSchema.parse('aa')).toBe('aa');
    expect(VisemeSchema.safeParse('th').success).toBe(false);
  });

  it('records the licence with the character asset', () => {
    // We ship nothing we cannot redistribute; the licence travels with the file so the
    // registry can show it without a lookup table somewhere else.
    const source = {
      id: 'alice-placeholder',
      url: '/assets/characters/placeholder.vrm',
      format: 'vrm',
      licence: 'CC0-1.0',
      attribution: null,
    };
    expect(CharacterSourceSchema.parse(source)).toEqual(source);
    const { licence: _dropped, ...withoutLicence } = source;
    expect(CharacterSourceSchema.safeParse(withoutLicence).success).toBe(false);
  });

  it('crossfades rather than snapping between clips', () => {
    const options = { loop: true, crossfadeMs: 250, weight: 1 };
    expect(ClipOptionsSchema.parse(options)).toEqual(options);
    expect(ClipOptionsSchema.safeParse({ ...options, crossfadeMs: -1 }).success).toBe(false);
    expect(ExpressionWeightsSchema.safeParse({ happy: 0.5 }).success).toBe(true);
  });
});
