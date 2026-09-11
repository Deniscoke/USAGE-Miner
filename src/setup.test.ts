import { describe, expect, it } from "vitest";
import { buildSetup, type SetupInput } from "./setup.js";

/**
 * The list exists because somebody who is not the author got stuck.
 *
 * His device paired, and the window then said "No eligible provider connected"
 * and "Not detected" three times. Every word of that was true and none of it
 * said what to do next, so these tests are mostly about what the steps SAY.
 */

function input(overrides: Partial<SetupInput> = {}): SetupInput {
  return {
    signedIn: true,
    eligibleProvider: true,
    anyProvider: true,
    meterableToolInstalled: true,
    unmeterableInstalled: [],
    ...overrides,
  };
}

describe("buildSetup", () => {
  it("disappears once everything is done", () => {
    const setup = buildSetup(input());
    expect(setup.complete).toBe(true);
    expect(setup.nextIndex).toBeNull();
    expect(setup.steps.every((step) => step.done)).toBe(true);
    expect(setup.steps.every((step) => step.action === null)).toBe(true);
  });

  it("points at the first unfinished step, not at all of them at once", () => {
    const setup = buildSetup(input({ signedIn: false, eligibleProvider: false, meterableToolInstalled: false }));
    expect(setup.nextIndex).toBe(0);
    expect(setup.steps[0]!.action?.kind).toBe("sign_in");
  });

  it("sends someone with no provider straight to connecting one", () => {
    // This is where he stopped. The action is a button, not an instruction to
    // go and find a page.
    const setup = buildSetup(input({ eligibleProvider: false, anyProvider: false }));
    const provider = setup.steps.find((s) => s.id === "provider")!;
    expect(provider.done).toBe(false);
    expect(provider.action).toEqual({ kind: "open", label: "Connect OpenRouter", target: "connect_provider" });
    expect(provider.detail).toMatch(/purchased credit/i);
  });

  it("says why a connected provider still cannot earn", () => {
    // The trap the owner hit with OpenAI: connected, routable, priced, and
    // earning nothing. "No provider connected" would be a lie here.
    const provider = buildSetup(input({ eligibleProvider: false, anyProvider: true })).steps.find((s) => s.id === "provider")!;
    expect(provider.detail).toMatch(/cannot earn yet/i);
    expect(provider.detail).toMatch(/no proof that the account behind it is paid/i);
    expect(provider.detail).not.toMatch(/no provider/i);
  });

  it("names the tools that are installed but useless, instead of saying nothing is there", () => {
    const tool = buildSetup(
      input({ meterableToolInstalled: false, unmeterableInstalled: ["Cursor"] }),
    ).steps.find((s) => s.id === "tool")!;
    expect(tool.detail).toMatch(/Cursor is installed, but cannot be measured/);
    expect(tool.action).toEqual({
      kind: "command",
      label: "Copy",
      command: "npm install -g @anthropic-ai/claude-code",
    });
  });

  it("reads as English with two spare tools as well as one", () => {
    const tool = buildSetup(
      input({ meterableToolInstalled: false, unmeterableInstalled: ["Cursor", "Gemini CLI"] }),
    ).steps.find((s) => s.id === "tool")!;
    expect(tool.detail).toMatch(/Cursor and Gemini CLI are installed/);
  });

  it("never claims a step is done on the app's own say-so", () => {
    // `eligibleProvider` is the SERVER's verdict. A window that decided this
    // for itself would tell people they are mining when they are not.
    const setup = buildSetup(input({ eligibleProvider: false }));
    expect(setup.complete).toBe(false);
    expect(setup.steps.find((s) => s.id === "provider")!.done).toBe(false);
  });
});
