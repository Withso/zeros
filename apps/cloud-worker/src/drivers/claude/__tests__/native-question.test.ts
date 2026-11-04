import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { claudeNativeApi, nativeQuestionInput } from "../../../../../../packages/protocol/src/__tests__/fixtures/claude-native-api";
import { ClaudeDriver } from "../driver";
import { text } from "./fake-query";

it.each([true, false])("runs Full access through the pinned native tool loop with question support=%s", async supported => {
  const fixture = await claudeNativeApi(directory => [
    { name: "Write", input: { file_path: join(directory, "output.txt"), content: "ordinary tool ran" } },
    { name: "Bash", input: { command: "printf native-fixture", description: "Offline fixture output" } },
    { name: "AskUserQuestion", input: nativeQuestionInput },
  ]);
  const onQuestion = vi.fn(async () => ({ outcome: { outcome: "answered" as const, answers: [{ questionId: "q0", selectedOptionIds: ["o1"] }] } }));
  const onPermission = vi.fn(async () => ({ outcome: { outcome: "cancelled" as const } }));
  const hooks: string[] = [];
  const driver = new ClaudeDriver({ executable: fixture.executable, query: args => query({ ...args, options: {
    ...args.options, env: fixture.env, persistSession: false, settingSources: [], strictMcpConfig: true,
    hooks: { ...args.options.hooks, ...(args.options.hooks?.PreToolUse ? { PreToolUse: args.options.hooks.PreToolUse.map(matcher => ({ ...matcher,
      hooks: matcher.hooks.map(callback => async (...params) => { hooks.push(params[0].hook_event_name === "PreToolUse" ? params[0].tool_name : "other"); return callback(...params); }),
    })) } : {}) },
  } }) });
  try {
    await driver.open({ sessionId: "native-question", cwd: fixture.directory, model: "claude-sonnet-4-6", apiKey: "offline-native-fixture-key",
      ...(supported ? { onQuestion, onPermission } : {}) });
    await expect(driver.prompt(text("Run the offline fixture tools."))).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(await readFile(join(fixture.directory, "output.txt"), "utf8")).toBe("ordinary tool ran");
    expect(fixture.results.get("toolu_fixture_1")?.is_error).toBeFalsy();
    expect(fixture.results.get("toolu_fixture_2")?.is_error).toBeFalsy();
    expect(onPermission).not.toHaveBeenCalled();
    expect(fixture.requests[0].tools?.some(tool => tool.name === "AskUserQuestion")).toBe(supported);
    if (supported) {
      expect(onQuestion).toHaveBeenCalledOnce(); expect(hooks).toEqual(["AskUserQuestion"]);
      expect(fixture.results.get("toolu_fixture_3")?.is_error).toBeFalsy();
      expect(JSON.stringify(fixture.results.get("toolu_fixture_3")?.content)).toContain("Blue");
    } else { expect(onQuestion).not.toHaveBeenCalled(); expect(hooks).toEqual([]); }
  } finally { await driver.dispose(); await fixture.close(); }
}, 30_000);

it("keeps the next native Write gated after a cloud allow-once plan approval, like Local", async () => {
  const fixture = await claudeNativeApi(directory => [
    { name: "ExitPlanMode", input: { plan: "Create output.txt with offline contents." } },
    { name: "Write", input: { file_path: join(directory, "output.txt"), content: "approved once" } },
  ]);
  const permissions: string[] = [];
  const driver = new ClaudeDriver({ executable: fixture.executable, query: args => query({ ...args, options: {
    ...args.options, env: fixture.env, persistSession: false, settingSources: [], strictMcpConfig: true,
  } }) });
  try {
    await driver.open({ sessionId: "native-plan", cwd: fixture.directory, model: "claude-sonnet-4-6", modeId: "plan", apiKey: "offline-native-fixture-key",
      onPermission: async request => { permissions.push(request.toolCall.title ?? ""); return { outcome: { outcome: "selected", optionId: "allow_once" } }; } });
    await expect(driver.prompt(text("Run the offline fixture tools."))).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(permissions).toEqual(["ExitPlanMode", "Write"]);
    expect(await readFile(join(fixture.directory, "output.txt"), "utf8")).toBe("approved once");
  } finally { await driver.dispose(); await fixture.close(); }
}, 30_000);
