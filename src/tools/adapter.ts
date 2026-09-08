/**
 * The local tool boundary.
 *
 * A tool adapter knows one thing: how a specific AI client is configured to
 * talk to a different endpoint. Adding a tool means writing one adapter; the
 * miner core never learns tool-specific details.
 *
 * TWO RULES EVERY ADAPTER FOLLOWS.
 *
 * 1. NEVER DESTROY A USER'S CONFIGURATION. Read what is there, keep a rollback
 *    copy, make the smallest possible change, and put it back exactly on
 *    disable. If the tool already points somewhere custom, stop and ask -- a
 *    silent overwrite could redirect somebody's work to the wrong provider or
 *    the wrong bill.
 *
 * 2. NOTHING HERE IS REMOTELY STEERABLE. Adapters ship compiled into the miner.
 *    The server sends declarative routing values (a URL, a protocol, a
 *    connection id) and never anything that decides *what runs*.
 */

export type ToolId = "claude-code" | "codex";

export interface ToolDetection {
  installed: boolean;
  /** Version string when the tool reports one, else null. */
  version: string | null;
  /** Where its configuration lives, for the UI to explain what will change. */
  configPath: string;
}

export type RoutingState =
  | { state: "off" }
  | { state: "usage"; url: string }
  /** Pointed somewhere that is not USAGE. Never overwritten without consent. */
  | { state: "foreign"; url: string }
  | { state: "unreadable"; reason: string };

export interface RouteConfig {
  /** Where the tool should send requests. Non-secret. */
  url: string;
  /** The device's own scoped credential. Never a provider key. */
  minerToken: string;
  /** Shown to the user so they know which connection they are mining through. */
  label: string;
}

export interface EnableResult {
  ok: boolean;
  /** Set when the tool already had a custom endpoint and consent is needed. */
  requiresConfirmation?: boolean;
  message: string;
}

export interface LocalToolAdapter {
  readonly id: ToolId;
  readonly displayName: string;
  /** The wire format this tool speaks, so the core can pick a valid route. */
  readonly protocol: "anthropic_compatible" | "openai_compatible";

  detect(): Promise<ToolDetection>;
  inspectRouting(): Promise<RoutingState>;
  /** `force` proceeds over a foreign endpoint the user has confirmed. */
  enableMining(route: RouteConfig, force?: boolean): Promise<EnableResult>;
  /** Restores exactly what was there before. */
  disableMining(): Promise<EnableResult>;
  /** Cheap local check: is the configuration still what we wrote? */
  healthCheck(): Promise<{ ok: boolean; detail: string }>;
}

/** Where a rollback copy of a tool's configuration is kept. */
export function backupName(id: ToolId): string {
  return `${id}.backup.json`;
}
