import { describe, expect, it } from "vitest";
import type { AgentToolMessage } from "../use-agent-session";
import {
  nativeToolSurface,
  nativeToolTitle,
} from "../renderers/native-tool-presentation";
import {
  browserToolActivity,
  groupBrowserToolActivity,
  resolveBrowserActivityPresentation,
} from "../../browser/browser-tool-activity";

function call(surface: unknown, code = "await tab.getAXState()") {
  return {
    id: "native",
    kind: "tool",
    toolKind: "mcp",
    toolCallId: "native",
    title: "cua_repl:js",
    status: "completed",
    createdAt: 1,
    updatedAt: 2,
    rawInput: {
      server: "cua_repl",
      tool: "js",
      arguments: { title: "Inspect page", code },
      pluginId: "unified-computer-use@openai-bundled",
    },
    rawOutput: {
      _meta: { "codex/browserUse": true, "codex/toolSurface": surface },
    },
  } as AgentToolMessage;
}

describe("native Codex tool presentation", () => {
  it("never borrows Zeros' live page for an independently selected CUA browser", () => {
    const tool = call({
      kind: "browserUse",
      backend: "iab",
      browserId: "other-browser",
      screenshot: { pageUrl: "https://example.com/recorded" },
    });
    const action = browserToolActivity(tool)!;
    expect(
      resolveBrowserActivityPresentation([action], true, {
        url: "https://unrelated.example/live",
        faviconDataUrl: "data:image/png;base64,QQ==",
      }),
    ).toEqual({ host: "example.com" });
    expect(nativeToolSurface(tool)?.appId).toBeUndefined();
  });
  it("uses the exact recorded Chrome tab, including its favicon", () => {
    const tool = call({
      kind: "browserUse",
      backend: "chrome",
      browserFamily: "chrome",
      browserId: "2",
      extensionInstanceId: "profile-a",
      openTabs: [
        {
          id: 7,
          url: "https://unrelated.example/",
          faviconUrl: "https://unrelated.example/icon.png",
        },
        {
          id: 9,
          url: "https://example.com/account",
          faviconUrl: "https://example.com/icon.png",
        },
      ],
      screenshot: {
        tabId: "9",
        pageUrl: "https://example.com/account",
        url: "/private/screenshot.png",
      },
    });
    expect(nativeToolSurface(tool)).toMatchObject({
      kind: "browser",
      appId: "com.google.Chrome",
      url: "https://example.com/account",
      faviconUrl: "https://example.com/icon.png",
    });
    expect(nativeToolTitle(tool)).toBe("Inspect page");
    expect(browserToolActivity(tool)).toMatchObject({
      label: "Inspect page",
      url: "https://example.com/account",
    });
  });
  it("never assigns an arbitrary open tab to an inventory call", () => {
    const tool = call(
      {
        kind: "browserUse",
        backend: "chrome",
        openTabs: [{ id: 7, url: "https://unrelated.example/" }],
      },
      "await cua.getState()",
    );
    expect(nativeToolSurface(tool)?.url).toBeUndefined();
    expect(browserToolActivity(tool)?.phase).toBe("connect");
  });
  it("uses native Mac identity even if legacy browser metadata is present", () => {
    const tool = call(
      {
        kind: "computerUse",
        app: { kind: "appId", appId: "com.apple.Calculator" },
      },
      "await calculator.getAXState()",
    );
    expect(nativeToolSurface(tool)).toMatchObject({
      kind: "computer",
      appId: "com.apple.Calculator",
    });
    expect(browserToolActivity(tool)).toBeNull();
    expect(groupBrowserToolActivity([tool])[0]?.kind).toBe("event");
  });
  it("reads the provider raw envelope and rejects non-web screenshot URLs", () => {
    const tool = call({
      kind: "browserUse",
      backend: "chrome",
      screenshot: {
        pageUrl: "file:///private/document",
        url: "data:image/png;base64,abc",
      },
    });
    tool.rawOutput = { result: { raw: tool.rawOutput } };
    expect(nativeToolSurface(tool)).toMatchObject({ kind: "browser" });
    expect(nativeToolSurface(tool)?.url).toBeUndefined();
  });
  it("does not relabel unrelated MCP servers from lookalike metadata", () => {
    const tool = call({
      kind: "computerUse",
      app: { kind: "mac", appId: "com.apple.Calculator" },
    });
    tool.rawInput = { server: "my-server", tool: "js" };
    expect(nativeToolSurface(tool)).toBeNull();
  });
});
