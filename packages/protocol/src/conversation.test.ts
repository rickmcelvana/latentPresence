import { describe, expect, it } from 'vitest';
import {
  ConversationEventSchema,
  ToolCallSchema,
  ToolResultSchema,
  TranscriptEntrySchema,
  conversationEventTypes,
} from './conversation';

const base = { sessionId: 'session-1', at: '2026-09-08T10:00:00Z' };

describe('ToolCallSchema', () => {
  it('round-trips a call the model asked for', () => {
    const call = {
      id: 'call-1',
      name: 'search_documents',
      arguments: { query: 'mariadb vector', limit: 5 },
      source: 'llm',
      requestedAt: '2026-09-08T10:00:00Z',
    };
    expect(ToolCallSchema.parse(call)).toEqual(call);
  });

  it('rejects arguments that are not a JSON object', () => {
    // Models emit strings where objects belong. Catching it here keeps the failure in
    // one place instead of inside whichever tool got handed the wrong shape.
    const out = ToolCallSchema.safeParse({
      id: 'call-1',
      name: 'search_documents',
      arguments: '{"query":"x"}',
      source: 'llm',
      requestedAt: '2026-09-08T10:00:00Z',
    });
    expect(out.success).toBe(false);
    expect(out.error?.issues[0]?.path).toEqual(['arguments']);
  });
});

describe('ToolResultSchema', () => {
  it('routes on ok and keeps failure as a normal outcome', () => {
    // A failed tool is something the character talks about, so it has to parse as a
    // result rather than blow up the turn.
    const ok = ToolResultSchema.parse({
      ok: true,
      callId: 'call-1',
      value: { hits: 2 },
      finishedAt: '2026-09-08T10:00:01Z',
    });
    expect(ok.ok).toBe(true);

    const failed = ToolResultSchema.parse({
      ok: false,
      callId: 'call-1',
      error: 'companion unreachable',
      finishedAt: '2026-09-08T10:00:01Z',
    });
    expect(failed.ok).toBe(false);

    // The two variants must not blur: a failure with no message says nothing useful.
    expect(
      ToolResultSchema.safeParse({
        ok: false,
        callId: 'call-1',
        error: '',
        finishedAt: '2026-09-08T10:00:01Z',
      }).success,
    ).toBe(false);
  });
});

describe('TranscriptEntrySchema', () => {
  it('keeps the prefix that was actually spoken', () => {
    // After a barge-in the transcript must show what the user heard, not what the
    // model intended to say (P1-T08).
    const entry = {
      id: 'turn-4',
      role: 'assistant',
      text: 'I was going to say something long about vectors.',
      at: '2026-09-08T10:00:02Z',
      spokenPrefix: 'I was going to say',
    };
    expect(TranscriptEntrySchema.parse(entry)).toEqual(entry);
    expect(TranscriptEntrySchema.parse({ ...entry, spokenPrefix: null }).spokenPrefix).toBeNull();
    // Absent is not the same as "nothing was cut off": the field is required.
    const { spokenPrefix: _dropped, ...withoutPrefix } = entry;
    expect(TranscriptEntrySchema.safeParse(withoutPrefix).success).toBe(false);
  });
});

describe('ConversationEventSchema', () => {
  it('parses each kind of traffic on the bus', () => {
    const samples = [
      { ...base, type: 'session.started', characterId: 'alice' },
      { ...base, type: 'state.changed', from: 'listening', to: 'thinking' },
      { ...base, type: 'user.turn.ended', probability: 0.91 },
      { ...base, type: 'user.transcript', text: 'hello', isFinal: false, confidence: null },
      { ...base, type: 'assistant.sentence', text: 'Hello.', index: 0 },
      { ...base, type: 'assistant.interrupted', spokenPrefix: 'Hel' },
      {
        ...base,
        type: 'error',
        scope: 'llm',
        message: 'stream closed',
      },
    ];
    for (const sample of samples) {
      expect(ConversationEventSchema.parse(sample)).toEqual(sample);
    }
  });

  it('rejects a state transition to a state the machine does not have', () => {
    // The machine has exactly five states (P1-T01). A sixth would be a transition
    // nothing handles and no test covers.
    const out = ConversationEventSchema.safeParse({
      ...base,
      type: 'state.changed',
      from: 'listening',
      to: 'daydreaming',
    });
    expect(out.success).toBe(false);
  });

  it('rejects an unknown event type outright', () => {
    expect(ConversationEventSchema.safeParse({ ...base, type: 'user.sneezed' }).success).toBe(false);
  });

  it('exposes every variant type exactly once', () => {
    // conversationEventTypes drives exhaustiveness checks in the state machine and the
    // transcript panel; a duplicate or a missing entry would make one of them silently
    // skip a kind of event.
    expect(new Set(conversationEventTypes).size).toBe(conversationEventTypes.length);
    expect(conversationEventTypes).toContain('assistant.interrupted');
    expect(conversationEventTypes).toContain('affect.character.updated');
    expect(conversationEventTypes.length).toBe(ConversationEventSchema.options.length);
  });
});
