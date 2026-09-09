import { createHash } from "node:crypto";
import type { FlatLogRecord, ScalarAttribute } from "./otlp.js";

/**
 * What leaves this machine. Version 1.
 *
 * This is the whole vocabulary a local observation may use. It is a closed
 * list on purpose: a field that is not named here does not exist as far as
 * transmission is concerned, however a tool chose to label it. Adding a field
 * is a schema version, reviewed as one.
 *
 * Everything is compute METADATA. There is no field that could hold a prompt,
 * a response, a file path, a command, or a person's identity, so there is no
 * way for one to be sent by accident -- the type does not have the slot.
 */
export const LOCAL_OBSERVATION_SCHEMA = "local-usage-observation-v1";

export type LocalSourceType = "native_otel";

export interface LocalUsageObservation {
  schema: typeof LOCAL_OBSERVATION_SCHEMA;
  /** Which adapter produced it, and its version -- e.g. "claude-otel-adapter-v1". */
  adapter: string;
  tool: string;
  toolVersion: string | null;
  sourceType: LocalSourceType;

  provider: string;
  /** The model as the tool reported it. Null if the tool did not say. */
  model: string | null;

  /**
   * The provider's own request identity, when the tool passed it along. This
   * is the only field with economic significance, because it is the only one
   * a server can correlate against something it observed itself. Never made
   * up: null means the tool did not supply one.
   */
  upstreamRequestId: string | null;

  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  toolTokens: number | null;

  /** The tool's own estimate, in micro-USD. Never authoritative. */
  estimatedCostMicros: number | null;

  occurredAt: string;
  /** Random per launch. Groups events from one run; identifies nobody. */
  localSessionId: string;
  /**
   * Deterministic id for retry-safe delivery. Derived from the fields above,
   * so the same event uploaded twice is the same id -- and NOT an economic
   * identity: two genuinely different requests with identical counts in the
   * same nanosecond would collide, and that is fine, because nothing is paid
   * on this id.
   */
  localEventId: string;
}

/**
 * The exact list of keys an observation may carry, as data rather than as a
 * type, so a test can assert against it and so the uploader can strip anything
 * else as a last line of defence.
 */
export const OBSERVATION_FIELDS: readonly (keyof LocalUsageObservation)[] = [
  "schema",
  "adapter",
  "tool",
  "toolVersion",
  "sourceType",
  "provider",
  "model",
  "upstreamRequestId",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
  "toolTokens",
  "estimatedCostMicros",
  "occurredAt",
  "localSessionId",
  "localEventId",
];

/**
 * How one tool's telemetry maps onto the schema.
 *
 * An adapter is a table, not code: which event name to accept, and for each
 * observation field, which attribute key supplies it. Anything the table does
 * not mention is never read. That makes the privacy property auditable by
 * reading a dozen lines rather than tracing a parser.
 */
export interface TelemetryMapping {
  adapter: string;
  tool: string;
  provider: string;
  /** Only records whose `event.name` is exactly one of these are considered. */
  eventNames: readonly string[];
  /** Further filter on attributes, e.g. Codex only on `event.kind = response.completed`. */
  accept?: (attributes: Record<string, ScalarAttribute>) => boolean;
  fields: {
    model?: string;
    upstreamRequestId?: string;
    inputTokens?: string;
    outputTokens?: string;
    cacheReadTokens?: string;
    cacheWriteTokens?: string;
    reasoningTokens?: string;
    toolTokens?: string;
    /** Micro-USD integer attribute, if the tool provides one. */
    estimatedCostMicros?: string;
    /** USD float attribute, converted. Used only if the micros one is absent. */
    estimatedCostUsd?: string;
  };
}

function integer(value: ScalarAttribute | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && /^\d{1,15}$/.test(value)) return Number(value);
  return null;
}

function text(value: ScalarAttribute | undefined, max = 128): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

function usdToMicros(value: ScalarAttribute | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 1_000_000);
}

function isoFromNano(nano: bigint | null, fallback: Date): string {
  if (nano === null) return fallback.toISOString();
  const millis = Number(nano / 1_000_000n);
  if (!Number.isFinite(millis) || millis <= 0) return fallback.toISOString();
  return new Date(millis).toISOString();
}

/**
 * Turn flat records into observations, through one mapping.
 *
 * Records that do not match the mapping's event name are ignored -- prompts,
 * tool decisions, errors, whatever else the tool emits. A matching record
 * yields exactly the mapped fields and nothing else. A record that matches but
 * carries no usable token count is dropped: an observation with nothing to
 * observe is noise.
 */
export function normalizeRecords(
  records: readonly FlatLogRecord[],
  mapping: TelemetryMapping,
  context: { toolVersion: string | null; localSessionId: string; now?: () => Date },
): LocalUsageObservation[] {
  const now = context.now ?? (() => new Date());
  const observations: LocalUsageObservation[] = [];

  for (const record of records) {
    const attributes = record.attributes;
    const eventName = attributes["event.name"];
    if (typeof eventName !== "string" || !mapping.eventNames.includes(eventName)) continue;
    if (mapping.accept && !mapping.accept(attributes)) continue;

    const read = (key: string | undefined) => (key ? attributes[key] : undefined);
    const inputTokens = integer(read(mapping.fields.inputTokens));
    const outputTokens = integer(read(mapping.fields.outputTokens));
    if (inputTokens === null && outputTokens === null) continue;

    const estimatedCostMicros =
      integer(read(mapping.fields.estimatedCostMicros)) ?? usdToMicros(read(mapping.fields.estimatedCostUsd));

    const partial = {
      schema: LOCAL_OBSERVATION_SCHEMA as typeof LOCAL_OBSERVATION_SCHEMA,
      adapter: mapping.adapter,
      tool: mapping.tool,
      toolVersion: context.toolVersion,
      sourceType: "native_otel" as const,
      provider: mapping.provider,
      model: text(read(mapping.fields.model)),
      upstreamRequestId: text(read(mapping.fields.upstreamRequestId), 200),
      inputTokens,
      outputTokens,
      cacheReadTokens: integer(read(mapping.fields.cacheReadTokens)),
      cacheWriteTokens: integer(read(mapping.fields.cacheWriteTokens)),
      reasoningTokens: integer(read(mapping.fields.reasoningTokens)),
      toolTokens: integer(read(mapping.fields.toolTokens)),
      estimatedCostMicros,
      occurredAt: isoFromNano(record.timeUnixNano, now()),
      localSessionId: context.localSessionId,
    };

    observations.push({
      ...partial,
      localEventId: createHash("sha256")
        .update(
          JSON.stringify([
            partial.tool,
            partial.localSessionId,
            partial.occurredAt,
            partial.model,
            partial.upstreamRequestId,
            partial.inputTokens,
            partial.outputTokens,
            partial.cacheReadTokens,
            partial.cacheWriteTokens,
          ]),
        )
        .digest("hex")
        .slice(0, 32),
    });
  }

  return observations;
}

/**
 * The last gate before anything is serialized: keep only the schema's keys.
 *
 * Every path that produces an observation already does this by construction.
 * This exists for the path that does not exist yet -- a future adapter that
 * spreads an attribute map into the object, a debugging field left in. The
 * uploader runs it on every observation, so such a mistake is a bug in what
 * gets shown locally, not in what gets sent.
 */
export function stripToSchema(candidate: Record<string, unknown>): LocalUsageObservation {
  const clean: Record<string, unknown> = {};
  for (const key of OBSERVATION_FIELDS) {
    if (key in candidate) clean[key] = candidate[key];
  }
  clean.schema = LOCAL_OBSERVATION_SCHEMA;
  return clean as unknown as LocalUsageObservation;
}
