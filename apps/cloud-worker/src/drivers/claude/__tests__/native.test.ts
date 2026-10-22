import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { ClaudeDriver } from "../driver";
import { input, result, text } from "./fake-query";

it.each([
  { effort: "low", expected: { settings: { effortLevel: "low", ultracode: false } } },
  { effort: "max", expected: { settings: { ultracode: false }, effort: "max" } },
  { effort: "ultracode", expected: { settings: { effortLevel: "xhigh", ultracode: true } } },
  { effort: "unknown", expected: { settings: { ultracode: false } } },
  { effort: undefined, expected: { settings: { ultracode: false } } },
])("serializes $effort and its model-change reset through the pinned SDK", async ({ effort, expected }) => {
  const directory = await mkdtemp(join(tmpdir(), "worker-claude-effort-"));
  const driver = new ClaudeDriver({ executable: fileURLToPath(new URL("./fixtures/cli.mjs", import.meta.url)), environment: { PATH: process.env.PATH, HOME: directory } });
  try {
    await driver.open({ ...input, effort, cwd: directory });
    await expect(driver.prompt(text(`fixture:${JSON.stringify([{ fixtureOptions: expected }, result("@input")])}`)))
      .resolves.toMatchObject({ stopReason: "end_turn" });
    await driver.setModel("claude-haiku-5-5");
    await expect(driver.prompt(text(`fixture:${JSON.stringify([{ fixtureFlagSettings: [{ effortLevel: null, ultracode: false }] }, result("@input")])}`)))
      .resolves.toMatchObject({ stopReason: "end_turn" });
  } finally { await driver.dispose(); await rm(directory, { recursive: true, force: true }); }
});

it.each([
  { login: { oauthToken: "offline-oauth-placeholder" }, name: "CLAUDE_CODE_OAUTH_TOKEN" },
  { login: { apiKey: "offline-api-key-placeholder" }, name: "ANTHROPIC_API_KEY" },
])("passes only $name through the real SDK and answers native control without parking a turn", async ({ login, name }) => {
  const directory = await mkdtemp(join(tmpdir(), "worker-claude-control-"));
  const driver = new ClaudeDriver({ executable: fileURLToPath(new URL("./fixtures/cli.mjs", import.meta.url)), environment: { PATH: process.env.PATH, HOME: directory,
    ZEROS_WORKER_TOKEN: "fixture-worker", CURSOR_API_KEY: "fixture-cursor", ZEROS_CLOUD_PROXY_TOKEN: "fixture-proxy",
    ANTHROPIC_BASE_URL: "https://example.invalid", ANTHROPIC_AUTH_TOKEN: "fixture-auth",
    ANTHROPIC_API_KEY: "fixture-api-key", CLAUDE_CODE_OAUTH_TOKEN: "fixture-oauth" } });
  try {
    await driver.open({ ...input, oauthToken: undefined, ...login, cwd: directory });
    const frames = [
      { fixtureEnvironment: { present: [name], absent: ["ZEROS_WORKER_TOKEN", "CURSOR_API_KEY", "ZEROS_CLOUD_PROXY_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"].filter(key => key !== name) } },
      // Bypass mode forbids installing canUseTool. The pinned SDK rejects an
      // unexpected permission request with an immediate control error.
      { fixtureControl: { subtype: "can_use_tool", tool_name: "AskUserQuestion", tool_use_id: "ask", input: { questions: [] } }, expectedSubtype: "error" },
      { fixtureControl: { subtype: "request_user_dialog", dialog_kind: "unknown", payload: {} }, field: "behavior", expected: "cancelled" },
      { fixtureControl: { subtype: "elicitation", mcp_server_name: "fixture", message: "Fixture question", requested_schema: {} }, field: "action", expected: "cancel" },
      result("@input"),
    ];
    await expect(driver.prompt(text(`fixture:${JSON.stringify(frames)}`))).resolves.toMatchObject({ stopReason: "end_turn" });
  } finally { await driver.dispose(); await rm(directory, { recursive: true, force: true }); }
});
