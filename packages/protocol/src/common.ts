import { z } from 'zod';

/** Identifier for anything the app stores. Opaque: ULID, UUID or a database key. */
export const IdSchema = z.string().min(1).max(128);
export type Id = z.infer<typeof IdSchema>;

/**
 * A moment in time as an ISO-8601 string with a `Z` or an offset. Timestamps cross
 * process, database and network boundaries, so they travel as strings and become
 * `Date` only at the edge that needs arithmetic.
 */
export const TimestampSchema = z.iso.datetime({ offset: true });
export type Timestamp = z.infer<typeof TimestampSchema>;

/** 0 to 1. Intensity, confidence, energy, a blend weight. */
export const UnitIntervalSchema = z.number().min(0).max(1);
export type UnitInterval = z.infer<typeof UnitIntervalSchema>;

/** -1 to 1. Valence, the PAD axes, anything with a neutral middle. */
export const SignedUnitSchema = z.number().min(-1).max(1);
export type SignedUnit = z.infer<typeof SignedUnitSchema>;

/** A non-negative duration in milliseconds. */
export const DurationMsSchema = z.number().int().min(0);
export type DurationMs = z.infer<typeof DurationMsSchema>;

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * Anything that survives `JSON.stringify`. Tool arguments and results are shaped by
 * whatever model or MCP server produced them, so this is as far as the type goes.
 */
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

/** A JSON object, the shape tool arguments and structured outputs actually take. */
export const JsonObjectSchema = z.record(z.string(), JsonValueSchema);
export type JsonObject = z.infer<typeof JsonObjectSchema>;
