import type { MinerConfig, MinerRoute } from "./api.js";
import type { LocalToolAdapter } from "./tools/adapter.js";

/**
 * Route selection (M16C0 §8). ONE implementation, used by the CLI and the
 * window, so the two cannot disagree about what "Start with USAGE" will do.
 *
 * REWARD FIRST, never route capability alone. `miningEligibility ===
 * "eligible_route"` says a connection is routable, measurable and priced;
 * `rewardStatus` is the server's economic verdict. A valid OpenAI API-key
 * connection is `eligible_route` and HELD (its funding is unknown); the
 * owner's OpenRouter OAuth connection is `eligible_route` and ELIGIBLE. The
 * old rule picked whichever came first. This one picks the route that earns:
 *
 *   1. an ELIGIBLE connected route
 *   2. a HELD connected route, only when nothing eligible exists
 *   3. INELIGIBLE / UNAVAILABLE routes are never chosen over either
 *   4. otherwise NO route. There is no USAGE-funded fallback any more.
 *
 * WHY THERE IS NO FALLBACK (0.4.7). The old fallback sent Claude Code to USAGE's
 * own gateway with only a header added, so Claude Code kept the user's
 * claude.ai subscription token in `Authorization` and carried it to USAGE. A
 * consumer subscription credential (Claude Pro/Max, ChatGPT and the like) must
 * never travel toward a USAGE route. A server that still advertises
 * `tools[tool].fallback` is ignored: nothing reads the field. With no route the
 * tool starts on its own sign-in, talking to its own provider, and USAGE only
 * tracks it locally ("Track only"), which does not earn.
 */

export type RewardStatus = "eligible" | "held" | "ineligible" | "unavailable";

export interface ChosenRoute {
  /** Always a connected provider route. The USAGE gateway fallback no longer exists. */
  kind: "provider";
  connectionId: string | null;
  url: string;
  label: string;
  /** Registry family ("openrouter"), for display and model defaults. */
  providerFamily: string | null;
  /** The wire surface the tool will speak on this route. */
  surface: "anthropic_compatible" | "openai_compatible";
  surfaceLabel: string;
  rewardStatus: RewardStatus;
  reason: string;
}

function rewardOf(route: MinerRoute): RewardStatus {
  // A server that predates the verdict field is treated as HELD, never as
  // eligible: absence of a verdict is not a verdict.
  return route.rewardStatus ?? "held";
}

export function chooseRoute(config: MinerConfig, adapter: Pick<LocalToolAdapter, "id" | "protocol">): ChosenRoute | null {
  const tool = config.tools[adapter.id];
  if (!tool || adapter.protocol === "none") return null;

  const candidates = tool.routes.filter((route) => route.protocol === adapter.protocol);
  const chosen = candidates.find((route) => rewardOf(route) === "eligible") ?? candidates.find((route) => rewardOf(route) === "held") ?? null;

  if (chosen) {
    return {
      kind: "provider",
      connectionId: chosen.connectionId,
      url: chosen.url,
      label: chosen.label,
      providerFamily: chosen.providerFamily ?? null,
      surface: chosen.surface ?? chosen.protocol,
      surfaceLabel: chosen.surfaceLabel ?? (chosen.protocol === "anthropic_compatible" ? "Anthropic-compatible" : "OpenAI-compatible"),
      rewardStatus: rewardOf(chosen),
      reason: chosen.miningLabel,
    };
  }

  // `tool.fallback` is deliberately never read. See rule 4 above.
  return null;
}
