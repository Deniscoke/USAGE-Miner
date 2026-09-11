/**
 * What is still missing before this computer can mine.
 *
 * Written after watching somebody who is not the author try it. His device
 * paired on the first go, and then he stopped: the window said "No eligible
 * provider connected" and "Not detected" three times, which is accurate and
 * tells a newcomer nothing about what to do. The configuration lives in three
 * different places -- an account on the website, a provider connection on the
 * website, an AI tool on this PC -- and nothing named them in one list or said
 * which one was his turn.
 *
 * So this is the list. Three steps, each with the one action that completes
 * it, and it disappears when they are all done rather than becoming permanent
 * furniture.
 *
 * It states what is missing; it never claims a step is done on its own say-so.
 * `provider` is complete only when the SERVER's verdict for the chosen route
 * is eligible, because a connection that routes but cannot earn is exactly the
 * state that made him think he was mining when he was not.
 */

export type SetupStepId = "account" | "provider" | "tool";

export interface SetupAction {
  /** `sign_in` and `open` are handled by the window; `command` is copied. */
  kind: "sign_in" | "open" | "command" | "refresh";
  label: string;
  /** For `open`: a target the window knows how to resolve. */
  target?: string;
  /** For `command`: exactly what to paste, and nothing implicit around it. */
  command?: string;
}

export interface SetupStep {
  id: SetupStepId;
  title: string;
  detail: string;
  done: boolean;
  action: SetupAction | null;
}

export interface SetupInput {
  signedIn: boolean;
  /** The server says the chosen route is a connected provider that can earn. */
  eligibleProvider: boolean;
  /** A provider is connected, whatever its verdict. */
  anyProvider: boolean;
  /** At least one installed tool USAGE can actually measure. */
  meterableToolInstalled: boolean;
  /** Installed tools USAGE cannot measure, named so the reader is not confused. */
  unmeterableInstalled: readonly string[];
}

export interface Setup {
  complete: boolean;
  /** 0-based index of the step the reader should do next, or null when done. */
  nextIndex: number | null;
  steps: SetupStep[];
}

const CLAUDE_CODE_INSTALL = "npm install -g @anthropic-ai/claude-code";

export function buildSetup(input: SetupInput): Setup {
  const account: SetupStep = {
    id: "account",
    title: "Connect this PC to your USAGE account",
    detail: input.signedIn
      ? "Done. This computer is paired with your account."
      : "Sign in once. Your browser opens, you approve this PC, and it finishes on its own.",
    done: input.signedIn,
    action: input.signedIn ? null : { kind: "sign_in", label: "Sign in" },
  };

  const provider: SetupStep = {
    id: "provider",
    title: "Connect an AI provider that can earn",
    detail: input.eligibleProvider
      ? "Done. Verified requests through your provider are reward eligible."
      : input.anyProvider
        ? // The trap: connected, working, earning nothing. Say why, not just that.
          "A provider is connected, but it cannot earn yet — USAGE has no proof that the account behind it is paid. OpenRouter, connected by signing in, does provide that proof."
        : "USAGE can only reward compute it can price and prove was paid for. Connect OpenRouter by signing in, on an account with purchased credit.",
    done: input.eligibleProvider,
    action: input.eligibleProvider
      ? null
      : { kind: "open", label: "Connect OpenRouter", target: "connect_provider" },
  };

  const spare = input.unmeterableInstalled.length > 0
    ? ` ${input.unmeterableInstalled.join(" and ")} ${input.unmeterableInstalled.length === 1 ? "is" : "are"} installed, but cannot be measured.`
    : "";

  const tool: SetupStep = {
    id: "tool",
    title: "Install an AI tool USAGE can measure",
    detail: input.meterableToolInstalled
      ? "Done. Start it from this window and your compute is measured as you work."
      : `USAGE measures Claude Code and Codex.${spare} Install Claude Code, then reopen this window.`,
    done: input.meterableToolInstalled,
    action: input.meterableToolInstalled
      ? null
      : { kind: "command", label: "Copy", command: CLAUDE_CODE_INSTALL },
  };

  const steps = [account, provider, tool];
  const nextIndex = steps.findIndex((step) => !step.done);

  return {
    complete: nextIndex === -1,
    nextIndex: nextIndex === -1 ? null : nextIndex,
    steps,
  };
}
