import { describe, expect, it } from 'vitest';
import {
  DurationMsSchema,
  IdSchema,
  JsonObjectSchema,
  JsonValueSchema,
  SignedUnitSchema,
  TimestampSchema,
  UnitIntervalSchema,
} from './common';

describe('IdSchema', () => {
  it('accepts an opaque key and rejects an empty one', () => {
    // An empty id reaching the database would silently become a row nobody can find.
    expect(IdSchema.parse('01JBQ8Z0000000000000000000')).toBe('01JBQ8Z0000000000000000000');
    expect(IdSchema.safeParse('').success).toBe(false);
  });
});

describe('TimestampSchema', () => {
  it('requires an explicit zone', () => {
    // A bare local time is ambiguous the moment it crosses a machine, and the dev
    // database is in another country (ADR-17).
    expect(TimestampSchema.parse('2026-09-08T10:00:00Z')).toBe('2026-09-08T10:00:00Z');
    expect(TimestampSchema.safeParse('2026-09-08T10:00:00+02:00').success).toBe(true);
    expect(TimestampSchema.safeParse('2026-09-08T10:00:00').success).toBe(false);
    expect(TimestampSchema.safeParse('yesterday').success).toBe(false);
  });
});

describe('numeric ranges', () => {
  it('holds unit and signed-unit bounds', () => {
    // Every weight, confidence and PAD axis is clamped here rather than in each caller.
    expect(UnitIntervalSchema.parse(0)).toBe(0);
    expect(UnitIntervalSchema.parse(1)).toBe(1);
    expect(UnitIntervalSchema.safeParse(1.0001).success).toBe(false);
    expect(UnitIntervalSchema.safeParse(-0.0001).success).toBe(false);

    expect(SignedUnitSchema.parse(-1)).toBe(-1);
    expect(SignedUnitSchema.safeParse(-1.5).success).toBe(false);
  });

  it('rejects a fractional millisecond duration', () => {
    expect(DurationMsSchema.parse(250)).toBe(250);
    expect(DurationMsSchema.safeParse(250.5).success).toBe(false);
    expect(DurationMsSchema.safeParse(-1).success).toBe(false);
  });
});

describe('JsonValueSchema', () => {
  it('parses nested tool output and rejects a value that cannot be serialised', () => {
    // Tool arguments and results come from models and MCP servers, so the guarantee
    // that matters is that whatever we store can be written back out as JSON.
    const nested = { a: [1, 'two', { b: null, c: [true] }] };
    expect(JsonValueSchema.parse(nested)).toEqual(nested);

    expect(JsonValueSchema.safeParse(undefined).success).toBe(false);
    expect(JsonValueSchema.safeParse(() => 1).success).toBe(false);
    expect(JsonValueSchema.safeParse(new Date()).success).toBe(false);
  });

  it('requires an object at the top for JsonObjectSchema', () => {
    expect(JsonObjectSchema.parse({ tool: 'search', args: { q: 'x' } })).toEqual({
      tool: 'search',
      args: { q: 'x' },
    });
    expect(JsonObjectSchema.safeParse([1, 2]).success).toBe(false);
  });
});
