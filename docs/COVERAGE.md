# What USAGE Miner can measure, per app and mode

Miner 0.4.8. Local telemetry is **LOCAL ONLY, TRACKED, reward 0** on the server
in every row below. Only a verified route earns.

Every row comes from three places:

- the miner's implementation: `src/tools/*.ts`, `src/telemetry/mappings.ts` and `src/coverage.ts`;
- its tests: `src/telemetry/privacy-upload.test.ts`, `src/tools/telemetry-launch.test.ts` and `src/tool-row.test.ts`;
- the app's own source, pinned to the version audited and cited below.

The window shows the "Coverage" column's label word for word. A mode marked
`DETECTED · USAGE DETAIL UNAVAILABLE` never shows a number.

## Capability table

| App / mode | Detected | Local telemetry supported | Input tokens | Output tokens | Cache tokens | Reasoning / thought tokens | Request correlation | Live events | Content-safe configuration | Known limitations |
|---|---|---|---|---|---|---|---|---|---|---|
| **Claude Code**, started from USAGE (`usage run claude-code`, terminal or `-p`) | `claude --version` | Yes: official OTLP logs, http/json, to the session's loopback receiver | Yes, `input_tokens` (fresh; excludes cache) | Yes, `output_tokens` | Read `cache_read_tokens`, write `cache_creation_tokens` | Not reported (null) | Anthropic `request_id` when the API returned one | Exported every 2 s (`OTEL_LOGS_EXPORT_INTERVAL=2000`) | All five content switches forced to `0`, metrics and traces `none`, enhanced-telemetry beta never set | Identity and name attributes (see below) are on the wire and dropped by the allowlist; no reasoning figure |
| **Claude Code**, started anywhere else (terminal, VS Code) | same | Yes, only while "Measure Claude Code everywhere" is on and the miner window runs (fixed port 47823, header key) | same | same | same | Not reported | same | same | Same switches, written as telemetry-only env in Claude Code's settings.json; removed on turn-off | Nothing is received while the window is closed |
| **Codex interactive** (`codex`), started from USAGE | `codex --version` | Yes: `-c` overrides for one invocation, `otlp-http` JSON exporter | Yes, `input_token_count` minus `cached_token_count` (Codex's input includes the cache) | Yes, `output_token_count` | Read `cached_token_count`, write `cache_write_token_count` | `reasoning_token_count` | None: the event has no request or response id | Batched; flushed at shutdown, with a 500 ms bound | `otel.log_user_prompt=false`, `metrics_exporter`/`trace_exporter` `none`; preflight refuses `log_user_prompt = true`, `otlp-grpc` or exporter TLS in `config.toml`/`managed_config.toml` | No correlation; last batch can be lost on a slow shutdown; `tool_token_count` is a total and is not read |
| **Codex exec** (`usage run codex exec …`) | same | Yes, same overrides (the `-c` flags are root-level, before `exec`) | same | same | same | same | None | Batched; flushed when `run_main` returns | same | A failing run calls `std::process::exit(1)`, which skips the flush, so its usage can be missing |
| **Codex in an editor** (IDE extension / app-server) | CLI detected only | **No.** The editor starts `codex app-server` with the user's own config, and USAGE writes no config file | — | — | — | — | — | — | Not applicable: nothing is received | Shown as `DETECTED · USAGE DETAIL UNAVAILABLE` |
| **Gemini CLI**, started from USAGE (interactive or `-p`) | `gemini --version` | Yes: env for one invocation, OTLP/HTTP JSON | Yes, `input_token_count` minus `cached_content_token_count` (Gemini's `promptTokenCount` includes cached content) | Yes, `output_token_count` | Read `cached_content_token_count`; no cache-write figure (null) | `thoughts_token_count`; also `tool_token_count` (tool-use prompt tokens) | None: no request id | Batched; flushed at exit, including `-p` | `GEMINI_TELEMETRY_LOG_PROMPTS=false`, traces off, `OTEL_NODE_RESOURCE_DETECTORS=none`, outfile and per-signal headers unset; preflight refuses settings `logPrompts` (any value but `false`) or `outfile` | A count Gemini did not receive arrives as `0`, not absent; `gen_ai.system_instructions`, `model_routing.reasoning` and error strings are on the wire and dropped by the allowlist |
| **Gemini CLI**, started anywhere else | same | **No.** USAGE writes no Gemini settings | — | — | — | — | — | — | Not applicable | Shown as `DETECTED · USAGE DETAIL UNAVAILABLE` |

"Cache tokens" means cache read and cache write kept separate. "Null" means
unknown, and it is never uploaded as `0`. Cursor is detected and reported as
unsupported: it has no local telemetry surface for personal accounts.

## What leaves the PC

Only `local-usage-observation-v1` (`OBSERVATION_FIELDS` in
`src/telemetry/observation.ts`), signed by the device key. No schema field was
added in 0.4.8.

`src/telemetry/privacy-upload.test.ts` runs one realistic OTLP/HTTP JSON export
per app through a real session: receiver, flattener, mapping, signer, uploader
and API client. It captures the exact JSON body at `fetch` and asserts four things:

1. No fixture secret appears anywhere in the body.
2. The envelope is exactly `{schema, observations[{observation, signature}]}`.
3. Each observation has exactly the `OBSERVATION_FIELDS` keys.
4. The token numbers are the expected ones, and unknown categories are `null`.

It then repeats the ingest with USAGE unreachable. It reads back every file the
miner wrote, including the DPAPI buffer decrypted, and asserts that no secret
was persisted.

The fixtures carry these secrets:

- **Claude Code:** `user.email`, `user.id`, `user.account_uuid`, `user.account_id`, `organization.id`, `session.id`, `prompt.id`, `skill.name`, `plugin.name`, `agent.name`, `marketplace.name`, `mcp_server.name`, `mcp_tool.name`, `terminal.type`, `vcs.*`, a workspace path, `host.name`, and a `user_prompt` event with `prompt`.
- **Codex:** `user.email`, `user.account_id`, `conversation.id`, `originator`, `terminal.type`, `cwd`, a repository URL, `sandbox_policy` with a path, `mcp_servers`, `codex.user_prompt` with `prompt`, `codex.tool_result` with `arguments`/`output`/`call_id`/`mcp_server`, and `codex.turn_cost`. It also includes the token-less HTTP `response.completed` frame.
- **Gemini CLI:** `user.email`, `session.id`, `installation.id`, `experiments.ids`, `auth_type`, `prompt_id`, `user_prompt.prompt`, `api_request.request_text`, `api_response.response_text`, `tool_call.function_args` and `metadata`, `gen_ai.system_instructions`, `model_routing.reasoning`, and a resource `process.command_args` holding a `-p` prompt.

Two gates drop these independently:

- `src/telemetry/otlp.ts` reads only scalar log-record attributes. It never reads bodies, resource attributes, arrays or maps.
- The per-tool mapping names the only attributes read.

The receiver keeps no raw export: records are flattened in memory, and only
observations reach the buffer.

## Sources

### Claude Code

Docs: https://code.claude.com/docs/en/monitoring-usage (2026-09)

- `claude_code.api_request` carries `model`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `cost_usd` and `request_id`.
- Standard attributes are `user.email`, `user.id`, `user.account_uuid`, `user.account_id`, `organization.id`, `session.id` and `terminal.type`.
- Content switches are `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES`, `OTEL_LOG_TOOL_DETAILS`, `OTEL_LOG_TOOL_CONTENT` and `OTEL_LOG_RAW_API_BODIES`.
- On the 2.1.26x wire, `event.name` is the bare `api_request`. Both spellings are accepted (`CLAUDE_CODE_MAPPING`).

### Codex (tag `rust-v0.153.3`, commit `b1a547b1f73ce86205d9222ac19cff334b3b7a2e`)

Base: `https://github.com/openai/codex/blob/rust-v0.153.3/`

**Config**
- `codex-rs/config/src/types.rs#L532-L601`: the `[otel]` keys, and `OtelExporterKind` with kebab-case variants `none`/`statsig`/`otlp-http`/`otlp-grpc`. `otlp-http` takes `{endpoint, headers, protocol: binary|json, tls}`.
- `codex-rs/core/src/config/otel.rs#L13-L21`: the defaults. `log_user_prompt` is false, `environment` is `"dev"`, `exporter` and `trace_exporter` are `None`, and `metrics_exporter` is `Statsig`.
- `codex-rs/utils/cli/src/config_override.rs#L49-L102`: a `-c` value is parsed as TOML, falling back to a plain string. `false` is a boolean.
- `codex-rs/config/src/overrides.rs`: overrides are applied in order into one layer. A dotted key under a non-table replaces it with a table. The layer is then deep-merged over the config files.
- `codex-rs/config/src/loader/mod.rs#L75-L88`: project-local config may not set `otel`.

**Endpoint**
- `codex-rs/otel/src/provider.rs#L470-L497`: the endpoint is passed to `with_endpoint` verbatim.
- opentelemetry-otlp 0.31.0 appends `/v1/logs` only for the env-var endpoint: https://github.com/open-telemetry/opentelemetry-rust/blob/v0.31.0/opentelemetry-otlp/src/exporter/http/mod.rs#L453-L483
- `codex-rs/otel/tests/suite/otlp_http_loopback.rs#L352` posts to `…/v1/logs`.

**Where the exporter is initialised**
- TUI: `codex-rs/tui/src/startup_orchestration.rs#L369-L400`, with shutdown bounded to 500 ms at `#L566-L572` (constant at `tui/src/lib.rs#L249`). Passing any `-c` forces the embedded in-process server (`tui/src/lib.rs#L919-L930`). Daemon reuse is Unix-only (`#L447-L474`).
- exec: `codex-rs/exec/src/lib.rs#L480-L509`. The provider is flushed by `Drop` (`otel/src/provider.rs#L96-L110`). `std::process::exit(1)` on failure (`exec/src/lib.rs#L1141-L1143`) skips it.
- app-server (IDE): `codex-rs/app-server/src/lib.rs#L586-L597`. It is configured from the user's config only.

**Events**
- `codex-rs/otel/src/events/session_telemetry.rs#L1011-L1030`: `codex.sse_event` with `event.kind=response.completed` carries `input_token_count`, `output_token_count`, `cached_token_count`, `cache_write_token_count`, `reasoning_token_count`, `tool_token_count` (= `total_tokens`), `ttft_ms`, `service_tier` and `model_reasoning_effort`.
  - It is emitted from `core/src/client.rs#L2224-L2233` for both HTTP (`#L1654`) and WebSocket (`#L1908`).
  - A stock OpenAI provider prefers WebSocket (`model-provider-info/src/lib.rs#L386`, `#L419`; `client.rs#L2016-L2066`).
  - HTTP also emits a token-less `response.completed` per SSE frame (`#L886-L993`).
- `codex-rs/otel/src/events/shared.rs#L14-L32`: every record carries `event.timestamp`, `conversation.id`, `app.version`, `auth_mode`, `originator`, `user.account_id`, `user.email`, `terminal.type`, `model` and `slug`.
- `session_telemetry.rs#L1032-L1073`: `codex.user_prompt` carries `prompt` (`"[REDACTED]"` unless `log_user_prompt`) and `prompt_length`.
- `codex-rs/otel/src/tool_result.rs#L35-L81`: `codex.tool_result` carries full `arguments`, an `output` preview (`otel.tool_result.max_bytes`, default 2048), `mcp_server`, `call_id`, `tool_name` and more.
- `session_telemetry.rs#L277-L333`: `codex.turn_cost` carries `usage.estimated_usd`. Not read.

### Gemini CLI (tag `v0.60.0`)

Base: `https://github.com/google-gemini/gemini-cli/blob/v0.60.0/`

**Settings and precedence**
- `docs/cli/telemetry.md#L35-L48`: the settings/env table. `logPrompts` defaults to true.
- `packages/core/src/telemetry/config.ts#L14-L19`: `parseBooleanEnvFlag` returns `value === 'true' || value === '1'`.
- `packages/core/src/telemetry/config.ts#L101-L109`: `logPrompts = argv ?? env ?? settings` and `outfile = argv ?? env ?? settings`.
- `packages/cli/src/config/config.ts#L766-L772`: resolution is called with env and settings only. The `--telemetry-*` flags are gone.
- `packages/core/src/config/config.ts#L1087-L1095`: `logPrompts ?? true`.
- `packages/cli/src/config/settings.ts#L106-L127`: system settings paths and `GEMINI_CLI_SYSTEM_SETTINGS_PATH` / `GEMINI_CLI_SYSTEM_DEFAULTS_PATH`.
- `packages/cli/src/config/settings.ts#L255-L281`: merge order is system-defaults, user, workspace, then system.
- `packages/core/src/utils/paths.ts#L22-L28`: `GEMINI_CLI_HOME`.

**Export**
- `packages/core/src/telemetry/sdk.ts#L282-L300`: for http, the endpoint path is extended with `v1/logs`, `v1/traces` and `v1/metrics`.
- The exporter is `@opentelemetry/exporter-logs-otlp-http` 0.218.0, which sends `application/json` and honours `OTEL_EXPORTER_OTLP_HEADERS`.
- `sdk.ts#L247`: an outfile disables OTLP.

**Events**
- `packages/core/src/telemetry/types.ts#L689-L733`: `api_response` carries `input_token_count = promptTokenCount ?? 0`, `output_token_count = candidatesTokenCount ?? 0`, `cached_content_token_count`, `thoughts_token_count`, `tool_token_count = toolUsePromptTokenCount`, `total_token_count`, `prompt_id`, `auth_type` and `status_code`. `response_text` is present only when logPrompts is on.
  - Per https://ai.google.dev/api/generate-content#UsageMetadata, `promptTokenCount` "includes the number of tokens in the cached content".
- `types.ts#L443-L458`: `api_request.request_text`, gated by logPrompts.
- `types.ts#L363-L410`: `tool_call.function_args` and `metadata`, gated by logPrompts.
- `types.ts#L209-L230`: `user_prompt.prompt`, gated by logPrompts.
- `packages/core/src/telemetry/telemetryAttributes.ts#L15-L29`: common attributes are `session.id`, `installation.id`, `interactive`, `user.email`, `auth_type` and `experiments.ids`.
- `types.ts#L647-L649`: `gen_ai.system_instructions` on `gen_ai.client.inference.operation.details`, **not** gated.
- `types.ts#L1525-L1553`: `model_routing.reasoning`, not gated.
- Resource `process.command_args` comes from the Node SDK's default process detector. Its detectors are disabled by `OTEL_NODE_RESOURCE_DETECTORS=none`.
- `packages/cli/src/gemini.tsx#L651`, `#L884-L885`: telemetry is registered before the interactive/non-interactive split. `runExitCleanup` awaits `shutdownTelemetry`, which flushes.

## Not verified by running

No row above was produced by running Codex or Gemini CLI against a real account
for this release. The Codex wire types (string versus int counts) come from
source, and from the 0.153.3 capture recorded in `src/telemetry/mappings.ts`.

Three things are still open:

- **Gemini CLI** is not installed on the audit machine.
- **Codex WebSocket prewarm:** whether the prewarm request (`client.rs#L1778-L1783`) also emits a token-bearing `response.completed`. If it does, it would appear as an extra small observation.
- **Codex over a USAGE verified route** (`wire_api = "chat"`): whether that path yields `token_usage` for the telemetry event was not re-checked here. Routed usage is measured by the USAGE gateway either way.
