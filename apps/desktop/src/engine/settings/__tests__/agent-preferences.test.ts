import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncAgentPreferences } from "../agent-preferences";
import { opSettingsWrite } from "../ops";

describe("acknowledged agent preferences", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "zeros-agent-preferences-"));
    process.env.ZEROS_USER_SETTINGS_DIR = root;
  });
  afterEach(() => {
    delete process.env.ZEROS_USER_SETTINGS_DIR;
    rmSync(root, { recursive: true, force: true });
  });
  it("imports missing legacy tables once and never resurrects a deleted table", () => {
    opSettingsWrite("user", { models: { default: "from-file" } });
    const legacy = {
      models: { default: "from-cache", default_plan_mode: true },
      providers: { claude: { auth: "api-key" } },
    };
    expect(syncAgentPreferences(legacy)).toMatchObject({
      models: { default: "from-file" },
      providers: { claude: { auth: "api-key" } },
    });
    opSettingsWrite("user", { models: null, providers: null });
    expect(syncAgentPreferences(legacy)).toEqual({ models: {}, providers: {} });
  });
  it("saves only edited leaves, preserving unknown file text and other controls", () => {
    opSettingsWrite("user", {
      models: { claude_code: { budget_cap_usd: 5, future: true } },
      providers: { claude: { auth: "cli" }, codex: { auth: "api-key" } },
    });
    const result = syncAgentPreferences({}, [
      { path: ["models", "claude_code", "budget_cap_usd"], value: null },
      {
        path: ["providers", "claude", "base_url"],
        value: "https://gateway.example",
      },
    ]);
    expect(result).toEqual({
      models: { claude_code: {} },
      providers: {
        claude: { auth: "cli", base_url: "https://gateway.example" },
        codex: { auth: "api-key" },
      },
    });
    expect(readFileSync(path.join(root, "settings.toml"), "utf8")).toContain(
      "future = true",
    );
  });
  it.each([
    { path: ["github", "auth_method"], value: "github-app" },
    { path: ["models", "made_up"], value: null },
    { path: ["providers", "__proto__", "auth"], value: "cli" },
    { path: ["models", "default_plan_mode"], value: "yes" },
  ])("rejects an invalid change without touching the file: %j", (change) => {
    syncAgentPreferences({});
    const before = readFileSync(path.join(root, "settings.toml"), "utf8");
    expect(() => syncAgentPreferences({}, [change])).toThrow();
    expect(readFileSync(path.join(root, "settings.toml"), "utf8")).toBe(before);
  });
});
