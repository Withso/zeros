import { describe, expect, it, vi } from "vitest";
import {
  readCodexSessionTools,
  authenticateCodexSessionTool,
} from "../session-tools";

describe("Codex session tool connections", () => {
  it("distinguishes discovery failure from a valid empty or cached catalog", async () => {
    const requestTyped = vi.fn().mockResolvedValue({
      data: [
        {
          name: "failed",
          runtimeStatus: "connected",
          tools: {},
          toolsError: "Tool discovery timed out.",
        },
        {
          name: "empty",
          runtimeStatus: "connected",
          tools: {},
          toolsError: null,
        },
        {
          name: "cached",
          runtimeStatus: "connected",
          tools: { retained: {} },
          toolsError: null,
        },
        { name: "legacy", runtimeStatus: "connected", tools: {} },
        {
          name: "auth",
          runtimeStatus: "authenticationRequired",
          authStatus: "notLoggedIn",
          toolsError: "Tool discovery requires authentication.",
        },
      ],
      nextCursor: null,
    });
    const snapshot = await readCodexSessionTools(
      { requestTyped } as never,
      "thread-a",
    );
    expect(snapshot.state).toBe("ready");
    expect(snapshot.entries).toEqual([
      {
        id: "failed",
        name: "failed",
        status: "error",
        detail: "Tool discovery timed out.",
      },
      { id: "empty", name: "empty", status: "connected" },
      { id: "cached", name: "cached", status: "connected" },
      { id: "legacy", name: "legacy", status: "connected" },
      {
        id: "auth",
        name: "auth",
        status: "needs-auth",
        canAuthenticate: true,
        detail: "Tool discovery requires authentication.",
      },
    ]);
  });

  it("bounds and scrubs discovery diagnostics before exposing the existing detail", async () => {
    const secret = "fixture-credential-value";
    const requestTyped = vi.fn().mockResolvedValue({
      data: [
        {
          name: "failed",
          runtimeStatus: "connected",
          toolsError: `Discovery failed: Authorization: Bearer ${secret}\n${"x".repeat(2000)}`,
        },
      ],
      nextCursor: null,
    });
    const result = await readCodexSessionTools(
      { requestTyped } as never,
      "thread-a",
    );
    expect(result.entries[0].detail).toContain("Discovery failed");
    expect(result.entries[0].detail).not.toContain(secret);
    expect(result.entries[0].detail!.length).toBeLessThanOrEqual(1000);
  });

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

  it.each(["", "   "])(
    "keeps an explicit discovery failure with blank explanation as an error: %j",
    async (toolsError) => {
      const requestTyped = vi.fn().mockResolvedValue({
        data: [{ name: "failed", runtimeStatus: "connected", toolsError }],
        nextCursor: null,
      });
      expect(
        (await readCodexSessionTools({ requestTyped } as never, "thread"))
          .entries[0],
      ).toMatchObject({ status: "error", detail: "Tool discovery failed." });
    },
  );

  it("removes URL credentials from native discovery diagnostics", async () => {
    const requestTyped = vi.fn().mockResolvedValue({
      data: [
        {
          name: "failed",
          runtimeStatus: "connected",
          toolsError:
            "Discovery failed at http://fixture-user:fixture-password@localhost:8080/mcp?token=fixture-token",
        },
      ],
      nextCursor: null,
    });
    const result = await readCodexSessionTools(
      { requestTyped } as never,
      "thread",
    );
    expect(result.entries[0].detail).toContain("Discovery failed");
    expect(result.entries[0].detail).not.toMatch(
      /fixture-user|fixture-password|fixture-token/,
    );
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
