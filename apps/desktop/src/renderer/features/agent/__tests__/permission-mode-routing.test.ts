import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function agentChatSource(): string {
  return readFileSync(
    resolve(
      process.cwd(),
      "apps/desktop/src/renderer/features/agent/agent-chat.tsx",
    ),
    "utf8",
  );
}

describe("permission-mode UI routing", () => {
  it("routes /plan through the durable enter/exit helpers", () => {
    const source = agentChatSource();
    const start = source.indexOf('case "plan": {');
    const end = source.indexOf('case "fast": {', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const planCase = source.slice(start, end);
    expect(planCase).toContain("if (isPlanMode) exitPlanMode();");
    expect(planCase).toContain("else enterPlan();");
    expect(planCase).not.toContain("session.setMode");
  });

  it("records every user-driven enter, exit, and direct native-mode pick", () => {
    const source = agentChatSource();
    expect(source).toContain(
      "rememberPermissionMode(chatAgentId, planAgentModeId);",
    );
    expect(source).toContain("rememberPermissionMode(chatAgentId, backId);");
    expect(source).toContain("rememberPermissionMode(chatAgentId, modeId);");
  });

  it("keeps exact permission ids across cross-agent and /clear chat creation", () => {
    const source = agentChatSource();
    expect(source).toContain("lastModeId: born.lastModeId,");
    expect(source).toContain(
      "...(born.lastModeId ? { lastModeId: born.lastModeId } : {}),",
    );
    expect(source).toContain("lastModeId: chatThread.lastModeId,");
    expect(source).toContain("prePlanModeId: chatThread.prePlanModeId,");
  });
});
