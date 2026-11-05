import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { claudeNativeApi, nativeQuestionInput } from "../../../../../../../../packages/protocol/src/__tests__/fixtures/claude-native-api";
import type { AgentAdapterContext, SessionNotification } from "../../../types";
import { ClaudeSdkAdapter } from "../adapter";

it.each(["bypass", "plan"])("uses Local's %s question/approval behavior in the pinned native tool loop", async mode => {
  const fixture = await claudeNativeApi(directory => mode === "bypass" ? [
    { name: "Write", input: { file_path: join(directory, "output.txt"), content: "ordinary tool ran" } },
    { name: "Bash", input: { command: "printf native-fixture", description: "Offline fixture output" } },
    { name: "AskUserQuestion", input: nativeQuestionInput },
  ] : [
    { name: "ExitPlanMode", input: { plan: "Create output.txt with offline contents." } },
    { name: "Write", input: { file_path: join(directory, "output.txt"), content: "ordinary tool ran" } },
  ]);
  const permissions: string[] = [], hooks: string[] = [], questions: string[] = [], events: SessionNotification[] = [];
  const ctx: AgentAdapterContext = { projectRoot: fixture.directory, mcpServers: [], sessionDirRoot: join(fixture.directory, "sessions"), emit: {
    onSessionUpdate: (_agent, event) => { events.push(event); }, onAgentStderr: () => {}, onAgentExit: () => {},
    onPermissionRequest: (_agent, id, request) => {
      permissions.push(request.toolCall.title ?? "");
      queueMicrotask(() => adapter.respondToPermission({ permissionId: id, response: { outcome: { outcome: "selected", optionId: "allow_once" } } }));
    },
    onQuestionRequest: (_agent, id) => {
      questions.push(id);
      queueMicrotask(() => adapter.respondToQuestion({ questionId: id,
        response: { outcome: { outcome: "answered", answers: [{ questionId: "q0", selectedOptionIds: ["o1"] }] } } }));
    },
  } } as AgentAdapterContext;
  const adapter = new ClaudeSdkAdapter(ctx, { queryFn: args => query({ ...args, options: {
    ...args.options, env: fixture.env, spawnClaudeCodeProcess: fixture.spawnClaudeCodeProcess, persistSession: false, settingSources: [], strictMcpConfig: true,
    hooks: { ...args.options?.hooks, ...(args.options?.hooks?.PreToolUse ? { PreToolUse: args.options.hooks.PreToolUse.map(matcher => ({ ...matcher,
      hooks: matcher.hooks.map(callback => async (...params) => { hooks.push(params[0].hook_event_name === "PreToolUse" ? params[0].tool_name : "other"); return callback(...params); }),
    })) } : {}) },
  } }) });
  try {
    const { session } = await adapter.newSession({ cwd: fixture.directory, cliBinary: fixture.executable,
      env: { ...fixture.env, ANTHROPIC_MODEL: "claude-sonnet-4-6", ZEROS_PERMISSION_MODE: mode } });
    await expect(adapter.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "Run the offline fixture tools." }] }))
      .resolves.toMatchObject({ stopReason: "end_turn" });
    expect(await readFile(join(fixture.directory, "output.txt"), "utf8")).toBe("ordinary tool ran");
    if (mode === "bypass") {
      expect(permissions).toEqual([]); expect(hooks).toEqual(["AskUserQuestion"]); expect(questions).toHaveLength(1);
      expect(fixture.requests[0].tools?.some(tool => tool.name === "AskUserQuestion")).toBe(true);
      expect(fixture.results.get("toolu_fixture_3")?.is_error).toBeFalsy();
      expect(JSON.stringify(fixture.results.get("toolu_fixture_3")?.content)).toContain("Blue");
    } else {
      expect(permissions).toEqual(["ExitPlanMode", "Write"]); expect(hooks).toEqual([]); expect(questions).toEqual([]);
      expect(events.filter(event => event.update.sessionUpdate === "current_mode_update").at(-1)?.update)
        .toMatchObject({ currentModeId: "default" });
    }
  } finally { await adapter.dispose(); await fixture.close(); }
}, 30_000);
