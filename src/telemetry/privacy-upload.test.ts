import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, sign as nodeSign } from "node:crypto";
import { OBSERVATION_FIELDS } from "./observation.js";
import type { LocalToolAdapter } from "../tools/adapter.js";

/**
 * The privacy property, asserted where it matters: on the bytes that leave.
 *
 * Each test drives a REAL metering session -- the loopback receiver, the OTLP
 * flattener, the per-tool mapping, the signer, the uploader and the API client
 * -- with one realistic OTLP/HTTP JSON export per tool, deliberately stuffed
 * with everything that must never leave this PC. `fetch` is spied at the edge,
 * so what is inspected is the exact JSON body USAGE would receive, not an
 * intermediate object someone could forget to route through a filter.
 *
 * Then the same export is sent with USAGE unreachable, and every file the miner
 * wrote is read back -- the offline buffer decrypted -- to show the raw export
 * was never persisted either.
 */

const SERVER = "https://usage.invalid";

let home: string;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  home = await mkdtemp(path.join(tmpdir(), "usage-privacy-"));
  process.env.APPDATA = path.join(home, "AppData");
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

const pair = generateKeyPairSync("ed25519");
const key = {
  publicKey: pair.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  sign: (payload: string) => nodeSign(null, Buffer.from(payload), pair.privateKey).toString("base64"),
};

// ------------------------------------------------------------------ OTLP JSON

type AnyValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean }
  | { arrayValue: { values: AnyValue[] } }
  | { kvlistValue: { values: { key: string; value: AnyValue }[] } };

function value(v: unknown): AnyValue {
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { boolValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(value) } };
  return { kvlistValue: { values: Object.entries(v as object).map(([k, x]) => ({ key: k, value: value(x) })) } };
}

const attrs = (record: Record<string, unknown>) => Object.entries(record).map(([k, v]) => ({ key: k, value: value(v) }));

function otlpExport(input: {
  resource: Record<string, unknown>;
  scope: string;
  records: { body?: string; attributes: Record<string, unknown> }[];
}) {
  return {
    resourceLogs: [
      {
        resource: { attributes: attrs(input.resource) },
        scopeLogs: [
          {
            scope: { name: input.scope },
            logRecords: input.records.map((r, i) => ({
              timeUnixNano: String(BigInt(Date.now()) * 1_000_000n + BigInt(i)),
              observedTimeUnixNano: String(BigInt(Date.now()) * 1_000_000n + BigInt(i)),
              severityNumber: 9,
              severityText: "INFO",
              ...(r.body !== undefined ? { body: { stringValue: r.body } } : {}),
              attributes: attrs(r.attributes),
            })),
          },
        ],
      },
    ],
  };
}

// ------------------------------------------------------------------ harness

interface Captured {
  uploads: { url: string; body: string }[];
}

function spyFetch(mode: "accept" | "unreachable"): Captured {
  const captured: Captured = { uploads: [] };
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(SERVER)) return realFetch(input, init);
    if (mode === "unreachable") throw new TypeError("fetch failed");
    const body = typeof init?.body === "string" ? init.body : "";
    captured.uploads.push({ url, body });
    if (url.endsWith("/api/miner/telemetry")) {
      const parsed = JSON.parse(body) as { observations: unknown[] };
      return new Response(JSON.stringify({ accepted: parsed.observations.length, duplicate: 0, rejected: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  });
  return captured;
}

/** Run one export through a real session. Returns what the session observed. */
async function ingest(adapter: LocalToolAdapter, payload: unknown): Promise<{ observed: number }> {
  const { startMeteringSession } = await import("./session.js");
  const session = await startMeteringSession({
    adapter,
    toolVersion: "9.9.9",
    serverUrl: SERVER,
    token: "usgm_test_device_credential",
    key,
    deviceId: "device-privacy-test",
  });
  const response = await realFetch(`${session.receiver.endpoint}/v1/logs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${session.receiver.sessionSecret}` },
    body: JSON.stringify(payload),
  });
  expect(response.status).toBe(200);
  const summary = await session.end();
  return { observed: summary.observed };
}

async function everyFileUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await everyFileUnder(full)));
    else out.push(full);
  }
  return out;
}

/** Every byte the miner persisted, with the offline buffer decrypted. */
async function persistedText(): Promise<string> {
  const { unprotectString } = await import("../secrets.js");
  const parts: string[] = [];
  for (const file of await everyFileUnder(home)) {
    const raw = await readFile(file, "utf8");
    parts.push(raw);
    if (file.endsWith(".dpapi")) parts.push(await unprotectString(raw));
  }
  return parts.join("\n");
}

function uploadedObservations(captured: Captured): Record<string, unknown>[] {
  const telemetry = captured.uploads.filter((u) => u.url.endsWith("/api/miner/telemetry"));
  return telemetry.flatMap((u) => (JSON.parse(u.body) as { observations: { observation: Record<string, unknown> }[] }).observations.map((o) => o.observation));
}

function assertUploadClean(captured: Captured, secrets: readonly string[]) {
  const telemetry = captured.uploads.filter((u) => u.url.endsWith("/api/miner/telemetry"));
  expect(telemetry.length).toBeGreaterThan(0);
  for (const upload of telemetry) {
    for (const secret of secrets) expect(upload.body, `upload body leaked ${secret}`).not.toContain(secret);
    const parsed = JSON.parse(upload.body) as { schema: string; observations: { observation: object; signature: object }[] };
    // The envelope is exactly schema + observations; each entry exactly observation + signature.
    expect(Object.keys(parsed).sort()).toEqual(["observations", "schema"]);
    for (const entry of parsed.observations) {
      expect(Object.keys(entry).sort()).toEqual(["observation", "signature"]);
      for (const k of Object.keys(entry.observation)) expect(OBSERVATION_FIELDS as readonly string[]).toContain(k);
      expect(Object.keys(entry.signature).sort()).toEqual(["value", "version"]);
    }
  }
}

beforeEach(async () => {
  const { clearBuffer } = await import("./buffer.js");
  await clearBuffer();
  await rm(path.join(home, "AppData"), { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ------------------------------------------------------------------ fixtures

/** Claude Code, shaped like its OTLP log export (code.claude.com/docs/en/monitoring-usage). */
const CLAUDE_SECRETS = {
  email: "claude.person@example.com",
  organization: "org-7f3a2b1c-secret-org",
  accountUuid: "acct-uuid-5d1e-secret",
  accountId: "user_account_id_secret_42",
  userId: "hashed-user-id-secret-99",
  skill: "secret-skill-deploy-prod",
  plugin: "secret-plugin-internal",
  agent: "secret-agent-reviewer",
  marketplace: "secret-marketplace-corp",
  mcpServer: "secret-mcp-server-jira",
  mcpTool: "secret-mcp-tool-search-tickets",
  terminal: "secret-terminal-wezterm",
  prompt: "CLAUDE PROMPT: rotate the prod database password to hunter2",
  sessionId: "claude-session-id-secret-1234",
  promptId: "claude-prompt-id-secret-5678",
  repo: "git@github.com:secret-org/secret-repo.git",
  cwd: "C:\\Users\\person\\secret-claude-project",
} as const;

function claudeFixture() {
  const common = {
    "session.id": CLAUDE_SECRETS.sessionId,
    "user.email": CLAUDE_SECRETS.email,
    "user.id": CLAUDE_SECRETS.userId,
    "user.account_uuid": CLAUDE_SECRETS.accountUuid,
    "user.account_id": CLAUDE_SECRETS.accountId,
    "organization.id": CLAUDE_SECRETS.organization,
    "terminal.type": CLAUDE_SECRETS.terminal,
    "app.version": "2.1.270",
    "prompt.id": CLAUDE_SECRETS.promptId,
    "skill.name": CLAUDE_SECRETS.skill,
    "plugin.name": CLAUDE_SECRETS.plugin,
    "agent.name": CLAUDE_SECRETS.agent,
    "marketplace.name": CLAUDE_SECRETS.marketplace,
    "mcp_server.name": CLAUDE_SECRETS.mcpServer,
    "mcp_tool.name": CLAUDE_SECRETS.mcpTool,
    "vcs.repository.url.full": CLAUDE_SECRETS.repo,
    "vcs.ref.head.name": "secret-branch-name",
    "workspace.path": CLAUDE_SECRETS.cwd,
  };
  return otlpExport({
    resource: { "service.name": "claude-code", "service.version": "2.1.270", "host.name": "SECRET-HOSTNAME" },
    scope: "com.anthropic.claude_code.events",
    records: [
      {
        body: "claude_code.user_prompt",
        attributes: { ...common, "event.name": "user_prompt", "event.timestamp": new Date().toISOString(), prompt_length: 58, prompt: CLAUDE_SECRETS.prompt },
      },
      {
        body: "claude_code.api_request",
        attributes: {
          ...common,
          "event.name": "api_request",
          "event.timestamp": new Date().toISOString(),
          model: "claude-sonnet-4-6",
          cost_usd: 0.0421,
          duration_ms: 3120,
          input_tokens: 1234,
          output_tokens: 567,
          cache_read_tokens: 89012,
          cache_creation_tokens: 3456,
          request_id: "req_011CWprivacyfixture",
          speed: "normal",
        },
      },
    ],
  });
}


/**
 * Codex, shaped like rust-v0.153.3's OTLP log export: the shared attributes
 * from codex-rs/otel/src/events/shared.rs on every record, the events from
 * session_telemetry.rs and tool_result.rs. The input, output and tool counts
 * are STRING attributes on the wire; cached, cache-write and reasoning are ints.
 * Includes the token-less `response.completed` SSE frame the HTTP path also
 * emits.
 */
const CODEX_SECRETS = {
  email: "codex.person@example.com",
  accountId: "codex-account-id-secret-7788",
  conversationId: "codex-conversation-id-secret-0199",
  originator: "codex_exec_secret_originator",
  terminal: "secret-terminal-windows-terminal",
  prompt: "CODEX PROMPT: exfiltrate the customer table to pastebin",
  toolArguments: '{"command":["powershell","-c","Get-Content C:\\\\Users\\\\person\\\\secret-codex-repo\\\\.env"]}',
  toolOutput: "OPENAI_API_KEY=sk-proj-secret-tool-output-value",
  callId: "call_secret_codex_tool_123",
  mcpServer: "secret-codex-mcp-server",
  sandboxPolicy: "workspace-write C:\\Users\\person\\secret-codex-repo",
  repository: "https://github.com/secret-org/secret-codex-repo.git",
  cwd: "C:\\Users\\person\\secret-codex-repo",
  turnId: "turn-secret-codex-4455",
} as const;

function codexFixture() {
  const shared = {
    "event.timestamp": new Date().toISOString(),
    "conversation.id": CODEX_SECRETS.conversationId,
    "app.version": "0.153.3",
    auth_mode: "Chatgpt",
    originator: CODEX_SECRETS.originator,
    "user.account_id": CODEX_SECRETS.accountId,
    "user.email": CODEX_SECRETS.email,
    "terminal.type": CODEX_SECRETS.terminal,
    model: "gpt-5.5-codex",
    slug: "gpt-5.5-codex",
    // Not attributes Codex sends today; here so a future one is caught.
    cwd: CODEX_SECRETS.cwd,
    "vcs.repository.url.full": CODEX_SECRETS.repository,
  };
  return otlpExport({
    resource: { "service.name": "codex_exec", "service.version": "0.153.3", env: "dev", "host.name": "SECRET-CODEX-HOST" },
    scope: "codex_otel.log_only",
    records: [
      { attributes: { ...shared, "event.name": "codex.conversation_starts", provider_name: "OpenAI", reasoning_effort: "high", sandbox_policy: CODEX_SECRETS.sandboxPolicy, mcp_servers: CODEX_SECRETS.mcpServer } },
      // As if log_user_prompt had been left on: the allowlist must hold anyway.
      { attributes: { ...shared, "event.name": "codex.user_prompt", prompt_length: 55, prompt: CODEX_SECRETS.prompt } },
      { attributes: { ...shared, "event.name": "codex.tool_decision", tool_name: "shell", call_id: CODEX_SECRETS.callId, decision: "approved", source: "config" } },
      {
        attributes: {
          ...shared,
          "event.name": "codex.tool_result",
          tool_name: "shell",
          call_id: CODEX_SECRETS.callId,
          arguments: CODEX_SECRETS.toolArguments,
          output: CODEX_SECRETS.toolOutput,
          mcp_server: CODEX_SECRETS.mcpServer,
          duration_ms: "412",
          success: "true",
        },
      },
      { attributes: { ...shared, "event.name": "codex.websocket_request", duration_ms: 20, success: true } },
      // The HTTP path's per-frame record: same kind, no counts. Must not become an observation.
      { attributes: { ...shared, "event.name": "codex.sse_event", "event.kind": "response.completed", duration_ms: 3 } },
      {
        attributes: {
          ...shared,
          "event.name": "codex.sse_event",
          "event.kind": "response.completed",
          input_token_count: "12000",
          output_token_count: "850",
          cached_token_count: 9000,
          cache_write_token_count: 0,
          reasoning_token_count: 320,
          tool_token_count: "12850",
          ttft_ms: 900,
          service_tier: "default",
          model_reasoning_effort: "high",
        },
      },
      { attributes: { ...shared, "event.name": "codex.turn_cost", "turn.id": CODEX_SECRETS.turnId, "usage.estimated_usd": "0.0421" } },
    ],
  });
}

/**
 * Gemini CLI, shaped like v0.60.0's export (packages/core/src/telemetry/types.ts,
 * telemetryAttributes.ts): common attributes on every record, the two records
 * each API response produces, and the content attributes that appear when
 * prompt logging is on -- present here to prove the allowlist, not the launch
 * settings, is what stops them.
 */
const GEMINI_SECRETS = {
  email: "gemini.person@example.com",
  sessionId: "gemini-session-id-secret-3141",
  installationId: "gemini-installation-id-secret-2718",
  promptId: "gemini-prompt-id-secret-1618",
  prompt: "GEMINI PROMPT: summarise the merger memo in secret-deal.docx",
  requestText: '[{"role":"user","parts":[{"text":"GEMINI REQUEST TEXT secret-deal"}]}]',
  responseText: '{"candidates":[{"content":{"parts":[{"text":"GEMINI RESPONSE TEXT merger terms"}]}}]}',
  functionArgs: '{"file_path":"C:\\\\Users\\\\person\\\\secret-gemini-project\\\\deal.docx"}',
  systemInstructions: "GEMINI SYSTEM INSTRUCTIONS from secret GEMINI.md",
  routingReasoning: "GEMINI ROUTING REASONING mentions secret-deal",
  commandArgs: 'gemini -p "GEMINI ARGV PROMPT secret-deal"',
  experiments: "secret-experiment-ids-4,8,15",
} as const;

function geminiFixture() {
  const common = {
    "session.id": GEMINI_SECRETS.sessionId,
    "installation.id": GEMINI_SECRETS.installationId,
    interactive: false,
    "user.email": GEMINI_SECRETS.email,
    auth_type: "oauth-personal",
    "experiments.ids": GEMINI_SECRETS.experiments,
  };
  return otlpExport({
    resource: { "service.name": "gemini-cli", "service.version": "0.60.0", "session.id": GEMINI_SECRETS.sessionId, "process.command_args": GEMINI_SECRETS.commandArgs },
    scope: "gemini-cli",
    records: [
      { body: "CLI configuration loaded.", attributes: { ...common, "event.name": "gemini_cli.config", model: "gemini-2.5-pro", log_user_prompts_enabled: true } },
      { body: "User prompt. Length: 60.", attributes: { ...common, "event.name": "gemini_cli.user_prompt", prompt_length: 60, prompt_id: GEMINI_SECRETS.promptId, prompt: GEMINI_SECRETS.prompt } },
      { body: "API request to gemini-2.5-pro.", attributes: { ...common, "event.name": "gemini_cli.api_request", model: "gemini-2.5-pro", prompt_id: GEMINI_SECRETS.promptId, request_text: GEMINI_SECRETS.requestText } },
      {
        body: "API response from gemini-2.5-pro. Status: 200. Duration: 2100ms.",
        attributes: {
          ...common,
          "event.name": "gemini_cli.api_response",
          "event.timestamp": new Date().toISOString(),
          model: "gemini-2.5-pro",
          duration_ms: 2100,
          input_token_count: 5000,
          output_token_count: 700,
          cached_content_token_count: 3000,
          thoughts_token_count: 450,
          tool_token_count: 60,
          total_token_count: 6210,
          prompt_id: GEMINI_SECRETS.promptId,
          status_code: 200,
          "http.status_code": 200,
          finish_reasons: ["STOP"],
          response_text: GEMINI_SECRETS.responseText,
        },
      },
      {
        body: "GenAI operation details from gemini-2.5-pro.",
        attributes: {
          ...common,
          "event.name": "gen_ai.client.inference.operation.details",
          "gen_ai.system_instructions": GEMINI_SECRETS.systemInstructions,
          "gen_ai.usage.input_tokens": 5000,
          "gen_ai.usage.output_tokens": 700,
        },
      },
      {
        body: "Tool call: read_file. Success: true.",
        attributes: {
          ...common,
          "event.name": "gemini_cli.tool_call",
          function_name: "read_file",
          function_args: GEMINI_SECRETS.functionArgs,
          prompt_id: GEMINI_SECRETS.promptId,
          metadata: { path: GEMINI_SECRETS.functionArgs },
        },
      },
      { attributes: { ...common, "event.name": "gemini_cli.model_routing", reasoning: GEMINI_SECRETS.routingReasoning } },
    ],
  });
}

// ------------------------------------------------------------------ tests

interface Case {
  name: string;
  adapter: () => Promise<LocalToolAdapter>;
  fixture: () => unknown;
  secrets: readonly string[];
  model: string;
  expected: Record<string, number | null>;
}

const CASES: Case[] = [
  {
    name: "Claude Code",
    adapter: async () => (await import("../tools/claude-code.js")).claudeCodeAdapter,
    fixture: claudeFixture,
    secrets: [...Object.values(CLAUDE_SECRETS), "SECRET-HOSTNAME", "secret-branch-name"],
    model: "claude-sonnet-4-6",
    // Claude Code reports no reasoning or tool figure: unknown, never 0.
    expected: { inputTokens: 1234, outputTokens: 567, cacheReadTokens: 89012, cacheWriteTokens: 3456, reasoningTokens: null, toolTokens: null },
  },
  {
    name: "Codex",
    adapter: async () => (await import("../tools/codex.js")).codexAdapter,
    fixture: codexFixture,
    secrets: [...Object.values(CODEX_SECRETS), "SECRET-CODEX-HOST", "0.0421"],
    model: "gpt-5.5-codex",
    // Fresh input is 12000 - 9000 cached. tool_token_count is a total and is
    // not read, so tool stays unknown.
    expected: { inputTokens: 3000, outputTokens: 850, cacheReadTokens: 9000, cacheWriteTokens: 0, reasoningTokens: 320, toolTokens: null },
  },
  {
    name: "Gemini CLI",
    adapter: async () => (await import("../tools/gemini-cli.js")).geminiCliAdapter,
    fixture: geminiFixture,
    secrets: [...Object.values(GEMINI_SECRETS), "oauth-personal"],
    model: "gemini-2.5-pro",
    // Fresh input is 5000 - 3000 cached. Gemini has no cache-write figure.
    expected: { inputTokens: 2000, outputTokens: 700, cacheReadTokens: 3000, cacheWriteTokens: null, reasoningTokens: 450, toolTokens: 60 },
  },
];

describe.each(CASES)("final upload payload: $name", (c) => {
  it("is exactly one observation of token counts, with no identity and no content", async () => {
    const captured = spyFetch("accept");
    const { observed } = await ingest(await c.adapter(), c.fixture());
    expect(observed).toBe(1);

    assertUploadClean(captured, c.secrets);
    const observations = uploadedObservations(captured);
    expect(observations).toHaveLength(1);
    const [observation] = observations;
    expect(Object.keys(observation).sort()).toEqual([...OBSERVATION_FIELDS].sort());
    expect(observation.model).toBe(c.model);
    expect(observation.upstreamRequestId === null || typeof observation.upstreamRequestId === "string").toBe(true);
    for (const [field, value] of Object.entries(c.expected)) expect(observation[field], field).toBe(value);
  });

  it("persists nothing of the raw export when USAGE is unreachable", async () => {
    spyFetch("unreachable");
    const { observed } = await ingest(await c.adapter(), c.fixture());
    expect(observed).toBe(1);
    const text = await persistedText();
    // The observation IS kept for later -- and only the observation.
    expect(text).toContain(c.model);
    for (const secret of c.secrets) expect(text, `persisted ${secret}`).not.toContain(secret);
  }, 60_000);
});
