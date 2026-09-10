import { describe, expect, it } from "vitest";
import { chooseRoute } from "./route.js";
import type { MinerConfig, MinerRoute } from "./api.js";

/**
 * M16C0 §8 / §17: reward first, route capability never on its own.
 */

function route(overrides: Partial<MinerRoute> & { label: string }): MinerRoute {
  return {
    connectionId: overrides.label.toLowerCase(),
    protocol: "anthropic_compatible",
    url: `https://usage.example/api/gateway/provider/${overrides.label.toLowerCase()}`,
    miningEligibility: "eligible_route",
    miningLabel: `Mining ${overrides.rewardStatus ?? "held"}`,
    ...overrides,
  };
}

function config(routes: MinerRoute[], fallback = true): MinerConfig {
  return {
    protocolVersion: "miner-protocol-v2",
    minimumMinerVersion: "0.3.0",
    updateRequired: false,
    account: { label: "a" },
    mining: { network: "n", scoringVersion: "v" },
    routes,
    routeSessions: { available: true, url: "https://usage.example/api/miner/route-session", ttlSeconds: 28800 },
    tools: {
      "claude-code": {
        protocol: "anthropic_compatible",
        routes: routes.filter((r) => r.protocol === "anthropic_compatible"),
        fallback: fallback ? { label: "USAGE gateway", url: "https://usage.example/api/gateway/anthropic", miningEligibility: "held", note: "USAGE-funded." } : null,
      },
      codex: { protocol: "openai_compatible", routes: routes.filter((r) => r.protocol === "openai_compatible"), fallback: null },
    },
    privacy: { recorded: [], neverRecorded: [] },
  };
}

const CLAUDE = { id: "claude-code", protocol: "anthropic_compatible" as const };
const CODEX = { id: "codex", protocol: "openai_compatible" as const };

describe("chooseRoute", () => {
  it("OpenAI held + OpenRouter eligible → OpenRouter, whichever the server listed first", () => {
    const openai = route({ label: "OpenAI", rewardStatus: "held", protocol: "anthropic_compatible" });
    const openrouter = route({ label: "OpenRouter", rewardStatus: "eligible", surface: "anthropic_compatible", surfaceLabel: "Anthropic-compatible", providerFamily: "openrouter", url: "https://usage.example/api/gateway/provider/or/anthropic" });
    for (const order of [[openai, openrouter], [openrouter, openai]]) {
      const chosen = chooseRoute(config(order), CLAUDE)!;
      expect(chosen.kind).toBe("provider");
      expect(chosen.label).toBe("OpenRouter");
      expect(chosen.rewardStatus).toBe("eligible");
      expect(chosen.surface).toBe("anthropic_compatible");
      expect(chosen.url).toContain("/anthropic");
    }
  });

  it("never prefers an eligible_route that is merely routable over a route that earns", () => {
    const heldFirst = route({ label: "OpenAI", rewardStatus: "held", miningEligibility: "eligible_route" });
    const earning = route({ label: "OpenRouter", rewardStatus: "eligible", miningEligibility: "eligible_route" });
    expect(chooseRoute(config([heldFirst, earning]), CLAUDE)!.label).toBe("OpenRouter");
  });

  it("a held provider route is used only when nothing is eligible, and is labelled held", () => {
    const chosen = chooseRoute(config([route({ label: "OpenAI", rewardStatus: "held" })]), CLAUDE)!;
    expect(chosen.kind).toBe("provider");
    expect(chosen.rewardStatus).toBe("held");
  });

  it("ineligible and unavailable routes are never chosen; the fallback is explicit and HELD", () => {
    const chosen = chooseRoute(config([route({ label: "Free", rewardStatus: "ineligible" }), route({ label: "Dead", rewardStatus: "unavailable" })]), CLAUDE)!;
    expect(chosen.kind).toBe("usage_gateway");
    expect(chosen.rewardStatus).toBe("held");
    expect(chosen.label).toBe("USAGE gateway");
  });

  it("with no eligible OpenRouter and no fallback there is no route at all", () => {
    expect(chooseRoute(config([route({ label: "Dead", rewardStatus: "unavailable" })], false), CLAUDE)).toBeNull();
    expect(chooseRoute(config([], false), CLAUDE)).toBeNull();
  });

  it("a server that sends no verdict is treated as held, never as eligible", () => {
    const chosen = chooseRoute(config([route({ label: "Old" })]), CLAUDE)!;
    expect(chosen.rewardStatus).toBe("held");
  });

  it("the same OpenRouter connection reaches Codex on its OpenAI surface and Claude Code on its Anthropic surface", () => {
    const openai = route({ label: "OpenRouter", connectionId: "or-1", rewardStatus: "eligible", protocol: "openai_compatible", surface: "openai_compatible", url: "https://usage.example/api/gateway/provider/or-1" });
    const anthropic = route({ label: "OpenRouter", connectionId: "or-1", rewardStatus: "eligible", protocol: "anthropic_compatible", surface: "anthropic_compatible", url: "https://usage.example/api/gateway/provider/or-1/anthropic" });
    const claude = chooseRoute(config([openai, anthropic]), CLAUDE)!;
    const codex = chooseRoute(config([openai, anthropic]), CODEX)!;
    expect(claude.connectionId).toBe("or-1");
    expect(codex.connectionId).toBe("or-1");
    expect(claude.url).not.toBe(codex.url);
    expect(claude.surface).toBe("anthropic_compatible");
    expect(codex.surface).toBe("openai_compatible");
  });
});
