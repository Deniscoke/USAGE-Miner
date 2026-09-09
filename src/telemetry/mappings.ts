import type { TelemetryMapping } from "./observation.js";

/**
 * One table per tool: which official telemetry event carries the request, and
 * which of its attributes USAGE reads.
 *
 * Every key here was taken from the tool's CURRENT official documentation or
 * source, not remembered. The URL and date are recorded beside each mapping so
 * the next person can check whether the tool has moved.
 *
 * What is conspicuously NOT here is the point: no `prompt`, no `response`, no
 * `user.email`, no `arguments`, no `output`, no `tool_input`, no workspace or
 * path attribute. Those exist on the wire from every one of these tools, and
 * they are dropped by never being named.
 */

/**
 * Claude Code -- https://code.claude.com/docs/en/monitoring-usage (2026-09).
 *
 * `claude_code.api_request` is the per-request event: model, all four token
 * categories, the tool's own cost estimate in integer micro-USD, and
 * `request_id` -- the Anthropic API request id, present only when the API
 * returned one. That id is what makes this adapter more than analytics: it is
 * the same identity USAGE's own gateway records, so a request that also went
 * through a USAGE route can be correlated exactly.
 *
 * Standard attributes on every event include `user.email`, `user.id`,
 * `organization.id` and `user.account_uuid`. None are read.
 */
export const CLAUDE_CODE_MAPPING: TelemetryMapping = {
  adapter: "claude-otel-adapter-v1",
  tool: "claude-code",
  provider: "anthropic",
  // The docs write "claude_code.api_request"; the wire, as of 2.1.261, puts
  // the bare "api_request" in `event.name` and the namespace elsewhere. Both
  // are accepted. Found by running the real tool, not by reading about it.
  eventNames: ["claude_code.api_request", "api_request"],
  fields: {
    model: "model",
    upstreamRequestId: "request_id",
    inputTokens: "input_tokens",
    outputTokens: "output_tokens",
    cacheReadTokens: "cache_read_tokens",
    cacheWriteTokens: "cache_creation_tokens",
    estimatedCostMicros: "cost_usd_micros",
    estimatedCostUsd: "cost_usd",
  },
};

/**
 * Gemini CLI -- github.com/google-gemini/gemini-cli docs/cli/telemetry.md and
 * packages/core/src/telemetry/types.ts (2026-09).
 *
 * `gemini_cli.api_response` carries the model and five token categories. It
 * carries NO upstream request identity in its log attributes, so every Gemini
 * observation is analytics-grade: real, useful to the user, and never
 * correlatable to an authoritative record. It also carries `response_text`
 * when prompt logging is on -- which the adapter turns off, and which this
 * table never reads regardless.
 */
export const GEMINI_CLI_MAPPING: TelemetryMapping = {
  adapter: "gemini-otel-adapter-v1",
  tool: "gemini-cli",
  provider: "google",
  eventNames: ["gemini_cli.api_response", "api_response"],
  fields: {
    model: "model",
    inputTokens: "input_token_count",
    outputTokens: "output_token_count",
    cacheReadTokens: "cached_content_token_count",
    reasoningTokens: "thoughts_token_count",
    toolTokens: "tool_token_count",
  },
};

/**
 * Codex -- codex-rs/otel/src/events/session_telemetry.rs (2026-09).
 *
 * Token counts arrive on `codex.sse_event` with `event.kind =
 * "response.completed"`. That event carries NO model attribute and NO response
 * id -- `model_reasoning_effort` is not a model, and `auth.request_id` on
 * `codex.api_request` is an auth-flow correlation id, not the model request.
 * So Codex telemetry yields counts with no model and no identity: observed,
 * analytics only, and labelled that way rather than padded out.
 *
 * `codex.tool_result` carries `arguments` and `output` -- tool content. Not
 * an accepted event name, so never parsed.
 */
export const CODEX_MAPPING: TelemetryMapping = {
  adapter: "codex-otel-adapter-v1",
  tool: "codex",
  provider: "openai",
  eventNames: ["codex.sse_event", "sse_event"],
  accept: (attributes) => attributes["event.kind"] === "response.completed",
  fields: {
    inputTokens: "input_token_count",
    outputTokens: "output_token_count",
    cacheReadTokens: "cached_token_count",
    cacheWriteTokens: "cache_write_token_count",
    reasoningTokens: "reasoning_token_count",
    toolTokens: "tool_token_count",
  },
};

export const MAPPINGS: Record<string, TelemetryMapping> = {
  "claude-code": CLAUDE_CODE_MAPPING,
  "gemini-cli": GEMINI_CLI_MAPPING,
  codex: CODEX_MAPPING,
};
