import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";

import { BrowserConfirmationBroker } from "../browser-confirmations";
import { connectSharedChrome, SharedChromeBrowserProvider } from "../shared-chrome-browser";

describe("SharedChromeBrowserProvider", () => {
  it("rejects a loopback discovery response that advertises a remote socket", async () => {
    const createWebSocket = vi.fn(() => new FakeWebSocket() as unknown as WebSocket);
    const fetchRequest = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({
        webSocketDebuggerUrl: "ws://attacker.example.test/devtools/browser/session",
      }), { status: 200, headers: { "content-type": "application/json" } }),
    );

    await expect(connectSharedChrome("http://127.0.0.1:9222", {
      fetch: fetchRequest,
      createWebSocket,
    })).rejects.toThrow(/this Mac/i);
    expect(createWebSocket).not.toHaveBeenCalled();
  });

  it("retains bounded console, network, and download diagnostics from the task page", async () => {
    let emitEvent = (_event: { method: string; params: Record<string, unknown> }) => undefined;
    const page = {
      navigate: vi.fn(async () => undefined),
      evaluate: vi.fn(async (expression: string) =>
        expression === "document.readyState"
          ? "complete"
          : { title: "Diagnostics", url: "https://example.com/", viewport: { width: 1280, height: 720 }, text: "", elements: [] },
      ),
      url: vi.fn(() => "https://example.com/"),
      back: vi.fn(async () => undefined),
      forward: vi.fn(async () => undefined),
      reload: vi.fn(async () => undefined),
      resize: vi.fn(async () => undefined),
      screenshot: vi.fn(async () => Buffer.from("jpeg")),
      setInputFiles: vi.fn(async () => undefined),
      send: vi.fn(async () => ({})),
      close: vi.fn(async () => undefined),
      onEvent: vi.fn((listener: typeof emitEvent) => {
        emitEvent = listener;
        return () => { emitEvent = () => undefined; };
      }),
    };
    const provider = new SharedChromeBrowserProvider({
      confirmations: new BrowserConfirmationBroker(),
      developerCdpEnabled: () => false,
      connect: async () => ({
        pageCount: async () => 1,
        createPage: async () => page,
        close: async () => undefined,
      }),
    });
    await provider.configure("http://127.0.0.1:9222");
    await provider.execute({ taskId: "task-1", tool: "open", arguments: { url: "https://example.com" } });

    emitEvent({ method: "Runtime.exceptionThrown", params: { exceptionDetails: { text: "Uncaught TypeError" } } });
    emitEvent({ method: "Network.loadingFailed", params: { errorText: "net::ERR_FAILED", canceled: false } });
    emitEvent({ method: "Network.responseReceived", params: { response: { status: 503, url: "https://example.com/api" } } });
    emitEvent({ method: "Page.downloadWillBegin", params: { url: "https://example.com/report.pdf", suggestedFilename: "report.pdf" } });

    const result = await provider.execute({ taskId: "task-1", tool: "snapshot", arguments: {} });
    const text = result.contentItems[0]?.type === "inputText" ? result.contentItems[0].text : "{}";
    const snapshot = JSON.parse(text);
    expect(snapshot.consoleErrors).toEqual(["Uncaught TypeError"]);
    expect(snapshot.networkErrors).toEqual([
      "net::ERR_FAILED",
      "HTTP 503 https://example.com/api",
    ]);
    expect(snapshot.downloads).toEqual([
      { url: "https://example.com/report.pdf", name: "report.pdf" },
    ]);
  });

  it("connects to the configured Chrome context and drives a dedicated task page", async () => {
    const navigate = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const page = {
      navigate,
      evaluate: vi.fn(async (expression: string) =>
        expression === "document.readyState"
          ? "complete"
          : {
              title: "Example",
              url: "https://example.com/",
              viewport: { width: 1280, height: 720 },
              text: "Hello",
              elements: [],
            },
      ),
      url: vi.fn(() => "https://example.com/"),
      back: vi.fn(async () => undefined),
      forward: vi.fn(async () => undefined),
      reload: vi.fn(async () => undefined),
      resize: vi.fn(async () => undefined),
      screenshot: vi.fn(async () => Buffer.from("jpeg")),
      setInputFiles: vi.fn(async () => undefined),
      send: vi.fn(async () => ({})),
      close,
    };
    const connection = {
      pageCount: vi.fn(async () => 0),
      createPage: vi.fn(async () => page),
      close: vi.fn(async () => undefined),
    };
    const connect = vi.fn(async () => connection);
    const provider = new SharedChromeBrowserProvider({
      confirmations: new BrowserConfirmationBroker(),
      developerCdpEnabled: () => false,
      connect,
    });

    await provider.configure("http://127.0.0.1:9222");
    await expect(provider.probe()).resolves.toEqual({
      connected: true,
      endpoint: "http://127.0.0.1:9222",
      pages: 0,
    });
    const result = await provider.execute({
      taskId: "task-1",
      tool: "open",
      arguments: { url: "https://example.com" },
    });

    expect(connect).toHaveBeenCalledWith("http://127.0.0.1:9222");
    expect(connection.createPage).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith("https://example.com/");
    expect(result.success).toBe(true);
    expect(result.contentItems[0]).toEqual(
      expect.objectContaining({
        type: "inputText",
        text: expect.stringContaining('"provider":"shared-chrome"'),
      }),
    );

    await provider.execute({ taskId: "task-1", tool: "close", arguments: {} });
    expect(close).toHaveBeenCalledOnce();
  });

  it("never forwards browser-terminating CDP methods to user-owned Chrome", async () => {
    const send = vi.fn(async () => ({}));
    const page = {
      url: () => "https://example.com/",
      evaluate: vi.fn(async (expression: string) =>
        expression === "document.readyState"
          ? "complete"
          : {
              title: "Example",
              url: "https://example.com/",
              viewport: { width: 800, height: 600 },
              text: "",
              elements: [],
            },
      ),
      navigate: vi.fn(async () => undefined),
      back: vi.fn(async () => undefined),
      forward: vi.fn(async () => undefined),
      reload: vi.fn(async () => undefined),
      resize: vi.fn(async () => undefined),
      screenshot: vi.fn(async () => Buffer.from("jpeg")),
      setInputFiles: vi.fn(async () => undefined),
      send,
      close: vi.fn(async () => undefined),
    };
    const provider = new SharedChromeBrowserProvider({
      confirmations: new BrowserConfirmationBroker(),
      developerCdpEnabled: () => true,
      connect: async () => ({
        pageCount: async () => 1,
        createPage: async () => page,
        close: async () => undefined,
      }),
    });
    await provider.configure("http://127.0.0.1:9222");
    await provider.execute({
      taskId: "task-1",
      tool: "open",
      arguments: { url: "https://example.com" },
    });

    for (const method of [
      "Browser.close",
      "Browser.setDownloadBehavior",
      "Browser.grantPermissions",
      "Target.createBrowserContext",
      "Target.createTarget",
      "Target.closeTarget",
    ]) {
      const result = await provider.execute({
        taskId: "task-1",
        tool: "cdp",
        arguments: { method, params: {} },
      });
      expect(result.success).toBe(false);
      expect(result.contentItems[0]).toEqual(
        expect.objectContaining({ text: expect.stringMatching(/not allowed/i) }),
      );
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("disconnects the old provider before accepting a changed endpoint", async () => {
    const firstClose = vi.fn(async () => undefined);
    const secondClose = vi.fn(async () => undefined);
    const connections = [
      {
        pageCount: vi.fn(async () => 1),
        createPage: vi.fn(),
        close: firstClose,
      },
      {
        pageCount: vi.fn(async () => 2),
        createPage: vi.fn(),
        close: secondClose,
      },
    ];
    const connect = vi
      .fn()
      .mockResolvedValueOnce(connections[0])
      .mockResolvedValueOnce(connections[1]);
    const provider = new SharedChromeBrowserProvider({
      confirmations: new BrowserConfirmationBroker(),
      developerCdpEnabled: () => false,
      connect,
    });

    await provider.configure("http://127.0.0.1:9222");
    await provider.probe();
    await provider.configure("http://127.0.0.1:9333");
    await expect(provider.probe()).resolves.toMatchObject({ pages: 2 });

    expect(firstClose).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenNthCalledWith(2, "http://127.0.0.1:9333");
    await provider.stop();
    expect(secondClose).toHaveBeenCalledOnce();
  });

  it("reconnects once when an open races a dropped DevTools connection", async () => {
    const firstPage = {
      url: () => "about:blank",
      evaluate: vi.fn(async () => "complete"),
      navigate: vi.fn(async () => { throw new Error("Shared Chrome disconnected."); }),
      back: vi.fn(), forward: vi.fn(), reload: vi.fn(), resize: vi.fn(), screenshot: vi.fn(),
      setInputFiles: vi.fn(), send: vi.fn(), close: vi.fn(async () => undefined),
    };
    const secondPage = {
      url: () => "https://example.com/",
      evaluate: vi.fn(async (expression: string) => expression === "document.readyState"
        ? "complete"
        : { title: "Recovered", url: "https://example.com/", viewport: { width: 800, height: 600 }, text: "ready", elements: [] }),
      navigate: vi.fn(async () => undefined),
      back: vi.fn(), forward: vi.fn(), reload: vi.fn(), resize: vi.fn(), screenshot: vi.fn(),
      setInputFiles: vi.fn(), send: vi.fn(), close: vi.fn(async () => undefined),
    };
    const firstConnection = {
      pageCount: vi.fn(async () => 1),
      createPage: vi.fn(async () => firstPage),
      close: vi.fn(async () => undefined),
    };
    const secondConnection = {
      pageCount: vi.fn(async () => 1),
      createPage: vi.fn(async () => secondPage),
      close: vi.fn(async () => undefined),
    };
    const connect = vi.fn()
      .mockResolvedValueOnce(firstConnection)
      .mockResolvedValueOnce(secondConnection);
    const provider = new SharedChromeBrowserProvider({
      confirmations: new BrowserConfirmationBroker(),
      developerCdpEnabled: () => false,
      connect,
    });
    await provider.configure("http://127.0.0.1:9222");

    const result = await provider.execute({
      taskId: "task-recover",
      tool: "open",
      arguments: { url: "https://example.com" },
    });

    expect(result.success).toBe(true);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(firstConnection.close).toHaveBeenCalledOnce();
    expect(secondPage.navigate).toHaveBeenCalledWith("https://example.com/");
    expect(JSON.stringify(result)).toContain("Recovered");
  });

  it("redacts managed-cloud credentials and advertised URL secrets from errors", async () => {
    const token = "cloud-token-that-must-never-leak";
    const provider = new SharedChromeBrowserProvider({
      confirmations: new BrowserConfirmationBroker(),
      developerCdpEnabled: () => false,
      providerName: "managed-cloud",
      normalizeEndpoint: (endpoint) => String(endpoint),
      redactSecrets: () => [token],
      connect: async () => {
        throw new Error(
          `Bearer ${token} rejected at wss://cloud.example.test/devtools?token=${token}`,
        );
      },
    });
    await provider.configure("https://cloud.example.test/cdp");

    const result = await provider.execute({
      taskId: "task-1",
      tool: "open",
      arguments: { url: "https://example.com" },
    });
    const message = result.contentItems[0]?.type === "inputText"
      ? result.contentItems[0].text
      : "";

    expect(result.success).toBe(false);
    expect(message).not.toContain(token);
    expect(message).toContain("[redacted]");
  });
});

class FakeWebSocket extends EventEmitter {
  readonly readyState = 1;
  close(): void { this.emit("close"); }
  send(): void {}
}
