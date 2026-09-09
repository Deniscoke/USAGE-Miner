import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { flattenOtlpLogs, OTLP_LIMITS } from "./otlp.js";
import {
  LOCAL_OBSERVATION_SCHEMA,
  OBSERVATION_FIELDS,
  normalizeRecords,
  stripToSchema,
  type LocalUsageObservation,
} from "./observation.js";
import { CLAUDE_CODE_MAPPING, CODEX_MAPPING, GEMINI_CLI_MAPPING } from "./mappings.js";
import { RECEIVER_LIMITS, startTelemetryReceiver } from "./receiver.js";
import { canonicalObservation, signObservations } from "./uploader.js";
import { claudeCodeAdapter } from "../tools/claude-code.js";
import { codexAdapter } from "../tools/codex.js";
import { geminiCliAdapter } from "../tools/gemini-cli.js";
import { cursorAdapter } from "../tools/cursor.js";
import { generateKeyPairSync, sign as nodeSign } from "node:crypto";
import { verifyWithPublicKey } from "../device-key.js";

/**
 * The privacy invariant, tested the only way it can be: by sending exactly the
 * things that must never leave, and asserting they did not.
 *
 * Every payload below is shaped the way the real tool sends it, with the real
 * attribute names from its documentation -- and then stuffed with prompts,
 * responses, paths, emails and raw bodies in the places the real tools put
 * them. If a future change lets any of that through, one of these fails.
 */

const attr = (key: string, value: string | number | boolean | object) => ({
  key,
  value:
    typeof value === "string"
      ? { stringValue: value }
      : typeof value === "boolean"
        ? { boolValue: value }
        : typeof value === "number"
          ? Number.isInteger(value)
            ? { intValue: String(value) }
            : { doubleValue: value }
          : Array.isArray(value)
            ? { arrayValue: { values: value.map((v) => ({ stringValue: String(v) })) } }
            : { kvlistValue: { values: Object.entries(value).map(([k, v]) => ({ key: k, value: { stringValue: String(v) } })) } },
});

function envelope(records: { time?: string; body?: unknown; attributes: ReturnType<typeof attr>[] }[]) {
  return {
    resourceLogs: [
      {
        resource: { attributes: [attr("service.name", "claude-code")] },
        scopeLogs: [
          {
            scope: { name: "com.anthropic.claude_code.events" },
            logRecords: records.map((r) => ({
              timeUnixNano: r.time ?? "1788883592000000000",
              body: r.body ?? { stringValue: "claude_code.api_request" },
              attributes: r.attributes,
            })),
          },
        ],
      },
    ],
  };
}

const SENSITIVE = {
  prompt: "Refactor the auth module and tell me my password is hunter2",
  response: "Here is the refactored code:\nfunction login()",
  email: "denis@example.com",
  path: "C:\\Users\\denis\\secret-project\\src\\auth.ts",
  command: "rm -rf ~/.ssh && cat /etc/shadow",
  rawBody: '{"messages":[{"role":"user","content":"SECRET PROMPT"}]}',
  sourceCode: "const API_KEY = \"sk-ant-live-000\";",
};

function claudeApiRequest(extra: ReturnType<typeof attr>[] = []) {
  return envelope([
    {
      attributes: [
        attr("event.name", "claude_code.api_request"),
        attr("event.timestamp", "2026-09-09T10:00:00Z"),
        attr("session.id", "sess-1"),
        attr("user.email", SENSITIVE.email),
        attr("user.id", "anon-123"),
        attr("organization.id", "org-9"),
        attr("user.account_uuid", "acct-uuid"),
        attr("terminal.type", "vscode"),
        attr("model", "claude-sonnet-5"),
        attr("cost_usd", 0.0123),
        attr("cost_usd_micros", 12300),
        attr("duration_ms", 1234),
        attr("input_tokens", 1500),
        attr("output_tokens", 240),
        attr("cache_read_tokens", 800),
        attr("cache_creation_tokens", 100),
        attr("request_id", "req_011CVabcdefgh"),
        attr("prompt.id", "prompt-uuid"),
        ...extra,
      ],
    },
  ]);
}

describe("OTLP flattening", () => {
  it("reads scalar attributes and refuses bodies, arrays and maps", () => {
    const records = flattenOtlpLogs(
      envelope([
        {
          body: { stringValue: SENSITIVE.prompt },
          attributes: [
            attr("event.name", "claude_code.user_prompt"),
            attr("prompt", SENSITIVE.prompt),
            attr("messages", [SENSITIVE.prompt, SENSITIVE.response]),
            attr("tool_input", { command: SENSITIVE.command, path: SENSITIVE.path }),
            attr("input_tokens", 10),
          ],
        },
      ]),
    );
    expect(records).toHaveLength(1);
    const [record] = records;
    // Body: never read. Array and map: dropped at the parser, before any adapter.
    expect(JSON.stringify(record.attributes)).not.toContain(SENSITIVE.command);
    expect(JSON.stringify(record.attributes)).not.toContain(SENSITIVE.response);
    expect(record.attributes.messages).toBeUndefined();
    expect(record.attributes.tool_input).toBeUndefined();
    expect(record.droppedComplexValues).toBe(3);
    // A scalar string attribute does survive flattening -- the allowlist is
    // what drops it. That is the second gate, tested below.
    expect(record.attributes.input_tokens).toBe(10);
  });

  it("caps records and attributes so parsing cannot be made expensive", () => {
    const many = envelope(
      Array.from({ length: OTLP_LIMITS.maxRecordsPerEnvelope + 50 }, () => ({
        attributes: [attr("event.name", "x")],
      })),
    );
    expect(flattenOtlpLogs(many)).toHaveLength(OTLP_LIMITS.maxRecordsPerEnvelope);
    expect(flattenOtlpLogs(null)).toEqual([]);
    expect(flattenOtlpLogs("garbage")).toEqual([]);
    expect(flattenOtlpLogs({ resourceLogs: "nope" })).toEqual([]);
  });
});

describe("Claude Code normalization", () => {
  const context = { toolVersion: "2.1.261", localSessionId: "sess-local" };

  it("keeps model, tokens, cache, cost estimate and the upstream request id", () => {
    const [obs] = normalizeRecords(flattenOtlpLogs(claudeApiRequest()), CLAUDE_CODE_MAPPING, context);
    expect(obs.schema).toBe(LOCAL_OBSERVATION_SCHEMA);
    expect(obs.adapter).toBe("claude-otel-adapter-v1");
    expect(obs.provider).toBe("anthropic");
    expect(obs.model).toBe("claude-sonnet-5");
    expect(obs.inputTokens).toBe(1500);
    expect(obs.outputTokens).toBe(240);
    expect(obs.cacheReadTokens).toBe(800);
    expect(obs.cacheWriteTokens).toBe(100);
    expect(obs.estimatedCostMicros).toBe(12300);
    expect(obs.upstreamRequestId).toBe("req_011CVabcdefgh");
    expect(obs.occurredAt).toBe("2026-09-08T16:06:32.000Z");
  });

  it("drops email, account and organisation identity", () => {
    const [obs] = normalizeRecords(flattenOtlpLogs(claudeApiRequest()), CLAUDE_CODE_MAPPING, context);
    const serialized = JSON.stringify(obs);
    expect(serialized).not.toContain(SENSITIVE.email);
    expect(serialized).not.toContain("acct-uuid");
    expect(serialized).not.toContain("org-9");
    expect(serialized).not.toContain("anon-123");
    expect(serialized).not.toContain("sess-1");
  });

  it("drops prompt, response, tool details, paths and raw bodies even when the tool sends them", () => {
    // What arrives if every privacy switch were flipped on -- the adapter sets
    // them off, but the allowlist must hold regardless.
    const hostile = claudeApiRequest([
      attr("prompt", SENSITIVE.prompt),
      attr("response", SENSITIVE.response),
      attr("tool_parameters", JSON.stringify({ file_path: SENSITIVE.path })),
      attr("tool_input", SENSITIVE.command),
      attr("bash_command", SENSITIVE.command),
      attr("raw_request_body", SENSITIVE.rawBody),
      attr("cwd", SENSITIVE.path),
      attr("workspace", SENSITIVE.path),
      attr("source", SENSITIVE.sourceCode),
    ]);
    const [obs] = normalizeRecords(flattenOtlpLogs(hostile), CLAUDE_CODE_MAPPING, context);
    const serialized = JSON.stringify(obs);
    for (const value of Object.values(SENSITIVE)) expect(serialized).not.toContain(value);
    expect(Object.keys(obs).sort()).toEqual([...OBSERVATION_FIELDS].sort());
  });

  it("accepts the bare event name the real tool emits", () => {
    // Observed from Claude Code 2.1.261 on 2026-09-09: `event.name` is
    // "api_request", not "claude_code.api_request". The documented form is
    // still accepted; the real one is what matters.
    const bare = envelope([
      {
        attributes: [
          attr("event.name", "api_request"),
          attr("model", "claude-sonnet-5"),
          attr("input_tokens", 3),
          attr("output_tokens", 4),
          attr("request_id", "req_real"),
          attr("prompt", SENSITIVE.prompt),
          attr("user.email", SENSITIVE.email),
        ],
      },
    ]);
    const [obs] = normalizeRecords(flattenOtlpLogs(bare), CLAUDE_CODE_MAPPING, context);
    expect(obs.upstreamRequestId).toBe("req_real");
    expect(JSON.stringify(obs)).not.toContain(SENSITIVE.prompt);
    expect(JSON.stringify(obs)).not.toContain(SENSITIVE.email);
  });

  it("never invents a request id", () => {
    const withoutId = envelope([
      {
        attributes: [
          attr("event.name", "claude_code.api_request"),
          attr("model", "claude-sonnet-5"),
          attr("input_tokens", 5),
          attr("output_tokens", 5),
          attr("client_request_id", "client-side-uuid"),
        ],
      },
    ]);
    const [obs] = normalizeRecords(flattenOtlpLogs(withoutId), CLAUDE_CODE_MAPPING, context);
    expect(obs.upstreamRequestId).toBeNull();
  });

  it("ignores every event that is not the request event", () => {
    const others = envelope(
      ["claude_code.user_prompt", "claude_code.tool_result", "claude_code.tool_decision", "claude_code.api_error", "claude_code.assistant_response"].map(
        (name) => ({
          attributes: [attr("event.name", name), attr("input_tokens", 99), attr("output_tokens", 99), attr("prompt", SENSITIVE.prompt)],
        }),
      ),
    );
    expect(normalizeRecords(flattenOtlpLogs(others), CLAUDE_CODE_MAPPING, context)).toEqual([]);
  });
});

describe("Gemini CLI normalization", () => {
  it("reads api_response counts and nothing textual", () => {
    const payload = envelope([
      {
        attributes: [
          attr("event.name", "gemini_cli.api_response"),
          attr("session.id", "g-sess"),
          attr("user.email", SENSITIVE.email),
          attr("model", "gemini-2.5-pro"),
          attr("input_token_count", 1200),
          attr("output_token_count", 300),
          attr("cached_content_token_count", 400),
          attr("thoughts_token_count", 150),
          attr("tool_token_count", 20),
          attr("total_token_count", 2070),
          attr("prompt_id", "p-1"),
          attr("response_text", SENSITIVE.response),
          attr("request_text", SENSITIVE.prompt),
        ],
      },
    ]);
    const [obs] = normalizeRecords(flattenOtlpLogs(payload), GEMINI_CLI_MAPPING, { toolVersion: "0.59.0", localSessionId: "s" });
    expect(obs.provider).toBe("google");
    expect(obs.model).toBe("gemini-2.5-pro");
    expect(obs.inputTokens).toBe(1200);
    expect(obs.reasoningTokens).toBe(150);
    expect(obs.toolTokens).toBe(20);
    // No request id in Gemini's event, and none invented.
    expect(obs.upstreamRequestId).toBeNull();
    const serialized = JSON.stringify(obs);
    expect(serialized).not.toContain(SENSITIVE.response);
    expect(serialized).not.toContain(SENSITIVE.prompt);
    expect(serialized).not.toContain(SENSITIVE.email);
  });
});

describe("Codex normalization -- truthful about what is not there", () => {
  it("takes counts only from response.completed, with no model and no id", () => {
    const payload = envelope([
      {
        attributes: [
          attr("event.name", "codex.sse_event"),
          attr("event.kind", "response.completed"),
          attr("input_token_count", 900),
          attr("output_token_count", 100),
          attr("cached_token_count", 300),
          attr("cache_write_token_count", 0),
          attr("reasoning_token_count", 50),
          attr("tool_token_count", 0),
          attr("model_reasoning_effort", "medium"),
        ],
      },
      {
        attributes: [attr("event.name", "codex.sse_event"), attr("event.kind", "response.output_item.done"), attr("input_token_count", 5), attr("output_token_count", 5)],
      },
      {
        attributes: [
          attr("event.name", "codex.tool_result"),
          attr("arguments", SENSITIVE.command),
          attr("output", SENSITIVE.sourceCode),
          attr("input_token_count", 1),
          attr("output_token_count", 1),
        ],
      },
    ]);
    const observations = normalizeRecords(flattenOtlpLogs(payload), CODEX_MAPPING, { toolVersion: "0.153.3", localSessionId: "s" });
    expect(observations).toHaveLength(1);
    expect(observations[0].model).toBeNull();
    expect(observations[0].upstreamRequestId).toBeNull();
    expect(observations[0].inputTokens).toBe(900);
    expect(observations[0].reasoningTokens).toBe(50);
    expect(JSON.stringify(observations)).not.toContain(SENSITIVE.command);
    expect(JSON.stringify(observations)).not.toContain(SENSITIVE.sourceCode);
  });

  it("is declared experimental with a local-observed ceiling", () => {
    const caps = codexAdapter.capabilities();
    expect(caps.experimental).toBe(true);
    expect(caps.verificationCeiling).toBe("local_observed");
    expect(caps.reads).not.toContain("model");
    expect(caps.reads).not.toContain("request_id");
  });
});

describe("Cursor", () => {
  it("is unsupported locally and says why", () => {
    const caps = cursorAdapter.capabilities();
    expect(caps.meteringMethods).toEqual(["unsupported"]);
    expect(caps.availabilityNote).toMatch(/Enterprise/);
    expect(cursorAdapter.telemetryLaunch({ endpoint: "x", sessionSecret: "y" })).toBeNull();
  });
});

describe("telemetry launch configuration", () => {
  const receiver = { endpoint: "http://127.0.0.1:55555", sessionSecret: "sess-secret-abc" };

  it("Claude Code: logs on, content switches off, endpoint local, bearer is the session secret", () => {
    const launch = claudeCodeAdapter.telemetryLaunch(receiver)!;
    expect(launch.env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1");
    expect(launch.env.OTEL_LOGS_EXPORTER).toBe("otlp");
    expect(launch.env.OTEL_METRICS_EXPORTER).toBe("none");
    expect(launch.env.OTEL_EXPORTER_OTLP_PROTOCOL).toBe("http/json");
    expect(launch.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(receiver.endpoint);
    expect(launch.env.OTEL_EXPORTER_OTLP_HEADERS).toBe("Authorization=Bearer sess-secret-abc");
    expect(launch.env.OTEL_LOG_USER_PROMPTS).toBe("0");
    expect(launch.env.OTEL_LOG_TOOL_DETAILS).toBe("0");
    expect(launch.env.OTEL_LOG_RAW_API_BODIES).toBe("0");
    // The miner credential is not in the telemetry environment.
    expect(JSON.stringify(launch)).not.toMatch(/usgm_/);
  });

  it("Gemini CLI: prompts and traces explicitly off", () => {
    const launch = geminiCliAdapter.telemetryLaunch(receiver)!;
    expect(launch.env.GEMINI_TELEMETRY_LOG_PROMPTS).toBe("false");
    expect(launch.env.GEMINI_TELEMETRY_TRACES_ENABLED).toBe("false");
    expect(launch.env.GEMINI_TELEMETRY_OTLP_PROTOCOL).toBe("http");
    expect(launch.env.GEMINI_TELEMETRY_OTLP_ENDPOINT).toBe(receiver.endpoint);
  });

  it("Codex: -c overrides for one invocation, prompts off", () => {
    const launch = codexAdapter.telemetryLaunch(receiver)!;
    expect(launch.args).toContain("otel.log_user_prompt=false");
    expect(launch.args.join(" ")).toContain(`${receiver.endpoint}/v1/logs`);
    expect(launch.args.join(" ")).toContain('otel.exporter.otlp-http.protocol="json"');
  });
});

describe("the local receiver treats localhost as hostile", () => {
  let receiver: Awaited<ReturnType<typeof startTelemetryReceiver>>;
  const received: unknown[] = [];

  beforeAll(async () => {
    receiver = await startTelemetryReceiver((records) => received.push(...records));
  });
  afterAll(async () => {
    await receiver.close();
  });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${receiver.endpoint}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  it("binds to loopback with a random port and a 32-byte secret", () => {
    expect(receiver.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(receiver.sessionSecret.length).toBeGreaterThanOrEqual(43);
  });

  it("rejects a foreign local process that lacks the session secret", async () => {
    expect((await post("/v1/logs", claudeApiRequest())).status).toBe(401);
    expect((await post("/v1/logs", claudeApiRequest(), { authorization: "Bearer wrong" })).status).toBe(401);
    expect(received).toHaveLength(0);
  });

  it("accepts the launched tool", async () => {
    const ok = await post("/v1/logs", claudeApiRequest(), { authorization: `Bearer ${receiver.sessionSecret}` });
    expect(ok.status).toBe(200);
    expect(received).toHaveLength(1);
  });

  it("acknowledges metrics and traces without reading them", async () => {
    const before = received.length;
    for (const path of ["/v1/metrics", "/v1/traces"]) {
      const r = await post(path, { resourceMetrics: [{ prompt: SENSITIVE.prompt }] }, { authorization: `Bearer ${receiver.sessionSecret}` });
      expect(r.status).toBe(200);
    }
    expect(received.length).toBe(before);
  });

  it("refuses oversized bodies and non-JSON encodings", async () => {
    const huge = "x".repeat(RECEIVER_LIMITS.maxBodyBytes + 1);
    // The receiver stops reading and drops the socket the moment the limit is
    // crossed rather than buffering the rest to answer politely. From the
    // sender's side that is either a 413 or a closed connection; both are a
    // refusal, and nothing was parsed.
    const big = await post("/v1/logs", huge, { authorization: `Bearer ${receiver.sessionSecret}` })
      .then((r) => r.status)
      .catch(() => "closed" as const);
    expect([413, 400, "closed"]).toContain(big);
    expect(received.length).toBe(1);

    const proto = await fetch(`${receiver.endpoint}/v1/logs`, {
      method: "POST",
      headers: { "content-type": "application/x-protobuf", authorization: `Bearer ${receiver.sessionSecret}` },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(proto.status).toBe(415);
  });
});

describe("device signature", () => {
  it("binds an observation to a key, and is verifiable with the public half", () => {
    const pair = generateKeyPairSync("ed25519");
    const key = {
      publicKey: pair.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
      sign: (payload: string) => nodeSign(null, Buffer.from(payload), pair.privateKey).toString("base64"),
    };
    const observation = normalizeRecords(flattenOtlpLogs(claudeApiRequest()), CLAUDE_CODE_MAPPING, {
      toolVersion: null,
      localSessionId: "s",
    })[0];
    const [signed] = signObservations([observation], key);
    expect(verifyWithPublicKey(key.publicKey, canonicalObservation(signed.observation), signed.signature.value)).toBe(true);
    // Any change to the numbers breaks it.
    const tampered = { ...signed.observation, inputTokens: 999_999 };
    expect(verifyWithPublicKey(key.publicKey, canonicalObservation(tampered), signed.signature.value)).toBe(false);
  });

  it("strips anything outside the schema before signing", () => {
    const pair = generateKeyPairSync("ed25519");
    const key = {
      publicKey: pair.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
      sign: (payload: string) => nodeSign(null, Buffer.from(payload), pair.privateKey).toString("base64"),
    };
    const smuggled = {
      ...normalizeRecords(flattenOtlpLogs(claudeApiRequest()), CLAUDE_CODE_MAPPING, { toolVersion: null, localSessionId: "s" })[0],
      prompt: SENSITIVE.prompt,
      proof_status: "confirmed",
      reward_status: "eligible",
      eligible_compute_micros: 1_000_000,
    } as unknown as LocalUsageObservation;
    const [signed] = signObservations([smuggled], key);
    const serialized = JSON.stringify(signed);
    expect(serialized).not.toContain(SENSITIVE.prompt);
    expect(serialized).not.toContain("proof_status");
    expect(serialized).not.toContain("reward_status");
    expect(Object.keys(signed.observation).sort()).toEqual([...OBSERVATION_FIELDS].sort());
  });
});

describe("the offline buffer holds metadata only", () => {
  let home: string;
  beforeAll(async () => {
    home = await mkdtemp(path.join(tmpdir(), "usage-buffer-"));
    process.env.APPDATA = path.join(home, "AppData");
  });
  afterAll(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("stores stripped observations, bounded, and drops expired ones", async () => {
    const { enqueue, pending, acknowledge, BUFFER_LIMITS } = await import("./buffer.js");
    const base = normalizeRecords(flattenOtlpLogs(claudeApiRequest()), CLAUDE_CODE_MAPPING, { toolVersion: null, localSessionId: "s" })[0];
    const stale = { ...base, localEventId: "old", occurredAt: new Date(Date.now() - BUFFER_LIMITS.maxAgeMs - 1000).toISOString() };
    const smuggled = { ...base, localEventId: "new", prompt: SENSITIVE.prompt } as unknown as LocalUsageObservation;

    await enqueue([stale, smuggled]);
    const waiting = await pending();
    expect(waiting.map((o) => o.localEventId)).toEqual(["new"]);
    expect(JSON.stringify(waiting)).not.toContain(SENSITIVE.prompt);

    // On disk it is DPAPI-protected, so the file itself carries no readable metadata either.
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(path.join(home, "AppData", "USAGE", "telemetry-buffer.dpapi"), "utf8");
    expect(raw).not.toContain("claude-sonnet-5");
    expect(raw).not.toContain("req_011");

    await acknowledge(["new"]);
    expect(await pending()).toEqual([]);
  });}, 30_000);
});

describe("stripToSchema", () => {
  it("is the closed vocabulary", () => {
    const out = stripToSchema({ tool: "x", prompt: "p", proof_status: "confirmed", schema: "evil" });
    expect(Object.keys(out)).toEqual(["schema", "tool"]);
    expect(out.schema).toBe(LOCAL_OBSERVATION_SCHEMA);
  });
});
