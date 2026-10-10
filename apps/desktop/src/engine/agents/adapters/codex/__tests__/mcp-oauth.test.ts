import { describe, expect, it, vi } from "vitest";
import { CodexAppServerTranslator } from "../app-server-translator";

const fixture = () => {
  const emit = vi.fn();
  const translator = new CodexAppServerTranslator({ sessionId: "session", emit });
  const complete = (name: string, loginId: string | null | undefined, success = true) =>
    translator.handle("mcpServer/oauthLogin/completed", { name, loginId, success });
  return { translator, emit, complete };
};

describe("Codex MCP OAuth correlation", () => {
  it("matches early completions after the response arrives and isolates each server", () => {
    const { translator, emit, complete } = fixture();
    const older = translator.beginMcpOauthLogin("linear");
    const newer = translator.beginMcpOauthLogin("linear");
    const other = translator.beginMcpOauthLogin("github");
    complete("linear", "older", false);
    complete("linear", "newer");
    complete("github", "other", false);
    translator.finishMcpOauthLogin("linear", older, "older");
    expect(translator.mcpOauthState("linear")).toBe("opening");
    expect(emit).not.toHaveBeenCalled();
    translator.finishMcpOauthLogin("linear", newer, "newer");
    translator.finishMcpOauthLogin("github", other, "other");
    expect(translator.mcpOauthState("linear")).toBe("connected");
    expect(translator.mcpOauthState("github")).toBe("error");
    expect(emit).toHaveBeenCalledOnce();
    translator.startTurn();
    complete("linear", "older", false);
    expect(translator.mcpOauthState("linear")).toBe("connected");
    expect(emit).toHaveBeenCalledOnce();
  });

  it.each([undefined, null])("preserves the older-server path with omitted login ids (%s)", loginId => {
    const { translator, complete } = fixture();
    const attempt = translator.beginMcpOauthLogin("linear");
    translator.finishMcpOauthLogin("linear", attempt);
    complete("linear", "unknown", false);
    expect(translator.mcpOauthState("linear")).toBe("opening");
    complete("linear", loginId);
    expect(translator.mcpOauthState("linear")).toBe("connected");
  });

  it("keeps a failed request terminal and ignores unknown explicit attempts", () => {
    const { translator, emit, complete } = fixture();
    const attempt = translator.beginMcpOauthLogin("linear");
    translator.failMcpOauthLogin("linear", attempt);
    complete("linear", undefined);
    complete("unknown", "unrequested", false);
    expect(translator.mcpOauthState("linear")).toBe("error");
    expect(emit).not.toHaveBeenCalled();
  });
  it("retains a matching early result after a burst of obsolete completions", () => {
    const { translator, complete } = fixture();
    const attempt = translator.beginMcpOauthLogin("linear");
    for (let index = 0; index < 12; index++) complete("linear", `older-${index}`, false);
    complete("linear", "latest");
    translator.finishMcpOauthLogin("linear", attempt, "latest");
    expect(translator.mcpOauthState("linear")).toBe("connected");
  });
});
