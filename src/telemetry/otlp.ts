/**
 * OTLP/JSON log parsing, reduced to the one thing USAGE needs from it.
 *
 * OTLP (OpenTelemetry Protocol) is what Claude Code, Gemini CLI and Codex all
 * speak. Its JSON encoding for logs is a nested envelope:
 *
 *   resourceLogs[] -> scopeLogs[] -> logRecords[] -> { attributes[], body, ... }
 *
 * where every attribute is `{ key, value: { stringValue | intValue | ... } }`.
 *
 * This module flattens that into `FlatLogRecord` and nothing more. It does not
 * interpret events, it does not know tool names, and it deliberately reads only
 * scalar attribute values: an attribute whose value is an array or a nested
 * object -- which is how a tool would carry a message list or a raw API body --
 * is dropped here, before any adapter can see it. That is the first of two
 * privacy gates, and it is the one that does not depend on knowing the schema.
 *
 * Nothing here retains the envelope. Once flattened, the original is garbage.
 */

export type ScalarAttribute = string | number | boolean;

export interface FlatLogRecord {
  /** Nanoseconds since the Unix epoch, as the tool reported it. Null if absent. */
  timeUnixNano: bigint | null;
  /** Scalar attributes only. Arrays, maps and bytes never reach this object. */
  attributes: Record<string, ScalarAttribute>;
  /**
   * Whether the record carried a non-scalar attribute or a body we discarded.
   * Kept as a count for diagnostics ("this tool sent 3 things we dropped"),
   * never as content.
   */
  droppedComplexValues: number;
}

/** Hard ceilings, so a hostile local sender cannot make parsing itself costly. */
export const OTLP_LIMITS = {
  maxRecordsPerEnvelope: 500,
  maxAttributesPerRecord: 128,
  maxStringAttributeLength: 512,
} as const;

interface AnyValue {
  stringValue?: unknown;
  intValue?: unknown;
  doubleValue?: unknown;
  boolValue?: unknown;
  arrayValue?: unknown;
  kvlistValue?: unknown;
  bytesValue?: unknown;
}

function scalar(value: AnyValue | undefined): ScalarAttribute | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (typeof value.stringValue === "string") {
    // Truncation is a size bound, not a privacy mechanism -- the allowlist in
    // observation.ts decides what survives. But no attribute USAGE wants is
    // longer than a request id, so anything past this is not for us.
    return value.stringValue.slice(0, OTLP_LIMITS.maxStringAttributeLength);
  }
  if (typeof value.intValue === "string" || typeof value.intValue === "number") {
    const parsed = Number(value.intValue);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (typeof value.doubleValue === "number" && Number.isFinite(value.doubleValue)) {
    return value.doubleValue;
  }
  if (typeof value.boolValue === "boolean") return value.boolValue;
  return undefined;
}

function isComplex(value: AnyValue | undefined): boolean {
  return Boolean(
    value && typeof value === "object" && (value.arrayValue || value.kvlistValue || value.bytesValue),
  );
}

function parseNano(value: unknown): bigint | null {
  if (typeof value === "string" && /^\d{1,20}$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return BigInt(Math.floor(value));
  }
  return null;
}

/**
 * Flatten an OTLP/JSON `ExportLogsServiceRequest`.
 *
 * Tolerant of shape -- a missing array is an empty one -- and strict about
 * content: only scalar attributes come through, and only up to the limits.
 * Malformed input yields an empty list rather than an exception, because the
 * sender is a local process and its mistakes are not our emergencies.
 */
export function flattenOtlpLogs(payload: unknown): FlatLogRecord[] {
  const records: FlatLogRecord[] = [];
  if (!payload || typeof payload !== "object") return records;

  const resourceLogs = (payload as { resourceLogs?: unknown }).resourceLogs;
  if (!Array.isArray(resourceLogs)) return records;

  for (const resource of resourceLogs) {
    const scopeLogs = (resource as { scopeLogs?: unknown })?.scopeLogs;
    if (!Array.isArray(scopeLogs)) continue;

    for (const scope of scopeLogs) {
      const logRecords = (scope as { logRecords?: unknown })?.logRecords;
      if (!Array.isArray(logRecords)) continue;

      for (const raw of logRecords) {
        if (records.length >= OTLP_LIMITS.maxRecordsPerEnvelope) return records;
        if (!raw || typeof raw !== "object") continue;

        const record = raw as {
          timeUnixNano?: unknown;
          observedTimeUnixNano?: unknown;
          attributes?: unknown;
          body?: unknown;
        };

        const attributes: Record<string, ScalarAttribute> = {};
        let dropped = 0;
        // The body is where a tool puts free text -- the prompt, the response,
        // the error message. It is never read.
        if (record.body !== undefined) dropped += 1;

        if (Array.isArray(record.attributes)) {
          let count = 0;
          for (const entry of record.attributes) {
            if (count >= OTLP_LIMITS.maxAttributesPerRecord) break;
            const key = (entry as { key?: unknown })?.key;
            const value = (entry as { value?: AnyValue })?.value;
            if (typeof key !== "string" || key.length === 0 || key.length > 128) continue;
            count += 1;
            if (isComplex(value)) {
              dropped += 1;
              continue;
            }
            const flat = scalar(value);
            if (flat === undefined) continue;
            attributes[key] = flat;
          }
        }

        records.push({
          timeUnixNano: parseNano(record.timeUnixNano) ?? parseNano(record.observedTimeUnixNano),
          attributes,
          droppedComplexValues: dropped,
        });
      }
    }
  }

  return records;
}
