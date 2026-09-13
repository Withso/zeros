import { describe, expect, it, vi } from "vitest";
import {
  readCodexSessionTools,
  authenticateCodexSessionTool,
} from "../session-tools";

describe("Codex session tool connections", () => {
  it("uses thread runtime status, aggregates apps, hides disabled servers and strips credentials", async () => {
    const requestTyped = vi.fn().mockResolvedValue({
      data: [
        {
          name: "codex_apps",
          runtimeStatus: "connected",
          authStatus: "oAuth",
          tools: { mail: {}, calendar: {} },
          url: "SECRET",
        },
        { name: "local", runtimeStatus: "disabled" },
        { name: "pending", runtimeStatus: "starting" },
        {
          name: "login",
          runtimeStatus: "authenticationRequired",
          authStatus: "notLoggedIn",
        },
        {
          name: "unknown",
          runtimeStatus: null,
          authStatus: "oAuth",
          tools: { cached: {} },
        },
        { name: "error", runtimeStatus: "failed", error: "SECRET" },
      ],
      nextCursor: null,
    });
    const result = await readCodexSessionTools(
      { requestTyped } as never,
      "thread-a",
    );
    expect(
      result.entries.map((e) => [e.name, e.status, e.canAuthenticate]),
    ).toEqual([
      ["codex_apps", "connected", undefined],
      ["pending", "connecting", undefined],
      ["login", "needs-auth", true],
      ["unknown", "error", undefined],
      ["error", "error", undefined],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/SECRET|mail|calendar/);
    expect(requestTyped).toHaveBeenCalledWith(
      "mcpServerStatus/list",
      expect.objectContaining({
        threadId: "thread-a",
        detail: "toolsAndAuthOnly",
      }),
      expect.any(Object),
    );
  });

  it("bounds repeated pagination without declaring the list complete", async () => {
    const requestTyped = vi
      .fn()
      .mockResolvedValue({ data: [], nextCursor: "repeat" });
    expect(
      (await readCodexSessionTools({ requestTyped } as never, "a")).state,
    ).toBe("partial");
    expect(requestTyped).toHaveBeenCalledTimes(2);
  });

  it("only authenticates an eligible server in the same thread and validates its browser URL", async () => {
    const requestTyped = vi
      .fn()
      .mockImplementation(async (method) =>
        method === "mcpServerStatus/list"
          ? {
              data: [
                {
                  name: "login",
                  runtimeStatus: "authenticationRequired",
                  authStatus: "notLoggedIn",
                },
              ],
              nextCursor: null,
            }
          : {
              authorizationUrl: "https://auth.example/authorize?state=fixture",
            },
      );
    const runtime = { requestTyped } as never;
    await expect(
      authenticateCodexSessionTool(runtime, "a", "unrelated"),
    ).rejects.toThrow("not available");
    expect(
      requestTyped.mock.calls.some(
        (call) => call[0] === "mcpServer/oauth/login",
      ),
    ).toBe(false);
    await expect(
      authenticateCodexSessionTool(runtime, "a", "login"),
    ).resolves.toEqual({
      authorizationUrl: "https://auth.example/authorize?state=fixture",
    });
    expect(requestTyped).toHaveBeenLastCalledWith(
      "mcpServer/oauth/login",
      { threadId: "a", name: "login" },
      expect.any(Object),
    );
    requestTyped.mockImplementation(async (method) =>
      method === "mcpServerStatus/list"
        ? {
            data: [
              {
                name: "login",
                runtimeStatus: "authenticationRequired",
                authStatus: "notLoggedIn",
              },
            ],
            nextCursor: null,
          }
        : { authorizationUrl: "file:///etc/passwd" },
    );
    await expect(
      authenticateCodexSessionTool(runtime, "a", "login"),
    ).rejects.toThrow("invalid authentication link");
  });
});
