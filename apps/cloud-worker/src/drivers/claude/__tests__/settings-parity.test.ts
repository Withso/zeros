import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { ClaudeDriver } from "../driver";
import { harness, input, result, text } from "./fake-query";

// Test-only Local import. Cloud's production driver remains standalone.
const localPath = fileURLToPath(new URL("../../../../../desktop/src/engine/agents/adapters/claude-sdk/adapter.ts", import.meta.url));
const { ClaudeSdkAdapter } = await import(localPath);
const local = Object.create(ClaudeSdkAdapter.prototype);
const knobs = (settings: Record<string, unknown>) => Object.fromEntries(Object.entries(settings)
  .filter(([key]) => ["effortLevel", "fastMode", "ultracode"].includes(key)));

it.each([undefined, "", "low", " medium ", "high", "xhigh", "ultracode", "max", "unknown"])("matches Local's initial and live settings for effort %s with Fast on and off", async effort => {
  const h = harness(), driver = new ClaudeDriver({ query: h.query, executable: "/fixture/claude", environment: {} });
  const expected = (fast: boolean) => knobs(local.buildFlagSettings({ env: {
    ...(effort !== undefined ? { ZEROS_THINKING_EFFORT: effort } : {}), ...(fast ? { ZEROS_FAST_MODE: "1" } : {}),
  } }));
  try {
    await driver.open({ ...input, effort, fast: true });
    const turn = driver.prompt(text("one")), query = h.queries[0], sent = await query.read();
    expect(query.args.options.settings).toEqual(expected(true));
    for (const fast of [false, true]) {
      await driver.updateConfig({ effort, fast });
      expect(query.flagSettings.at(-1)).toEqual({ ...expected(fast), ...(!effort?.trim() ? { effortLevel: null } : {}) });
    }
    query.push(result(sent.uuid)); await turn;
    expect(h.queries).toHaveLength(1);
  } finally { await driver.dispose(); }
});
