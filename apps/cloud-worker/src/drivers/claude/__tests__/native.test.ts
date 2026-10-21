import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { ClaudeDriver } from "../driver";
import { input, result, text } from "./fake-query";

it("answers actual SDK permission, question and elicitation control requests without parking a turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "worker-claude-control-"));
  const driver = new ClaudeDriver({ executable: fileURLToPath(new URL("./fixtures/cli.mjs", import.meta.url)), environment: { PATH: process.env.PATH, HOME: directory } });
  try {
    await driver.open({ ...input, cwd: directory });
    const frames = [
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
