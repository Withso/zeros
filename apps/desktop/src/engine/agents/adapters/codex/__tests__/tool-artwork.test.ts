import { describe, expect, it, vi } from "vitest";
import { createCodexToolArtworkResolver } from "../tool-artwork";
import type { CodexAppServerHandle } from "../app-server";

describe("Codex tool artwork", () => {
  it("shares app metadata across calls and scopes every read to the thread", async () => {
    const requestTyped = vi.fn(async (method: string) =>
      method === "app/installed"
        ? { apps: [{ id: "app-1", runtimeName: "workos", enabled: true }] }
        : {
            apps: [
              {
                id: "app-1",
                name: "WorkOS",
                iconUrl: "https://cdn.example.com/workos.png",
                iconUrlDark: "https://cdn.example.com/workos-dark.png",
              },
            ],
          },
    );
    const read = createCodexToolArtworkResolver(
      { requestTyped } as unknown as CodexAppServerHandle,
      "thread-a",
      "/workspace",
    );
    const [first, second] = await Promise.all([
      read({ server: "codex_apps", tool: "workos.query" }),
      read({ server: "codex_apps", tool: "workos.list" }),
    ]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      icon: "https://cdn.example.com/workos.png",
      iconDark: "https://cdn.example.com/workos-dark.png",
      name: "WorkOS",
    });
    expect(requestTyped).toHaveBeenCalledTimes(2);
    expect(requestTyped).toHaveBeenCalledWith(
      "app/read",
      { threadId: "thread-a", appIds: ["app-1"], includeTools: false },
      { timeoutMs: 4000 },
    );
  });
  it("uses a connector ID supplied by app-server without guessing from its tool name", async () => {
    const requestTyped = vi.fn(async () => ({
      apps: [
        {
          id: "exact-app",
          name: "App",
          iconUrl: "https://cdn.example.com/app.png",
        },
      ],
    }));
    const read = createCodexToolArtworkResolver(
      { requestTyped } as unknown as CodexAppServerHandle,
      "thread-b",
      "/workspace",
    );
    expect(
      await read({
        server: "codex_apps",
        tool: "opaque_tool",
        appContext: { connectorId: "exact-app" },
      }),
    ).toMatchObject({ name: "App" });
    expect(requestTyped).toHaveBeenCalledTimes(1);
  });
  it("fails quietly and never loads metadata for the native CUA server", async () => {
    const requestTyped = vi.fn(async () => {
      throw new Error("offline");
    });
    const read = createCodexToolArtworkResolver(
      { requestTyped } as unknown as CodexAppServerHandle,
      "thread",
      "/workspace",
    );
    expect(await read({ server: "cua_repl", tool: "js" })).toBeUndefined();
    expect(requestTyped).not.toHaveBeenCalled();
    expect(
      await read({ server: "codex_apps", tool: "workos.query" }),
    ).toBeUndefined();
  });
  it("uses actual MCP server artwork and ignores active/local URL schemes", async () => {
    const requestTyped = vi.fn(async () => ({
      data: [
        {
          name: "notes",
          runtimeStatus: "connected",
          tools: {},
          serverInfo: {
            title: "Notes",
            icons: [
              { src: "file:///secret.png" },
              { src: "https://cdn.example.com/notes.png" },
            ],
          },
        },
      ],
    }));
    const read = createCodexToolArtworkResolver(
      { requestTyped } as unknown as CodexAppServerHandle,
      "thread",
      "/workspace",
    );
    expect(await read({ server: "notes", tool: "find" })).toEqual({
      icon: "https://cdn.example.com/notes.png",
      name: "Notes",
    });
  });

  it("follows MCP inventory pages without repeating a cursor", async () => {
    const requestTyped = vi.fn(
      async (_method: string, params: { cursor?: string }) =>
        params.cursor
          ? {
              data: [
                {
                  name: "later",
                  runtimeStatus: "connected",
                  tools: {},
                  serverInfo: {
                    icons: [{ src: "https://cdn.example.com/later.png" }],
                  },
                },
              ],
              nextCursor: "next",
            }
          : { data: [], nextCursor: "next" },
    );
    const read = createCodexToolArtworkResolver(
      { requestTyped } as unknown as CodexAppServerHandle,
      "thread",
      "/workspace",
    );
    expect(await read({ server: "later", tool: "find" })).toMatchObject({
      icon: "https://cdn.example.com/later.png",
    });
    expect(requestTyped).toHaveBeenCalledTimes(2);
  });
});
