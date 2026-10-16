import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AGENT_CONTROL_SERVICE_TOKEN_ENV,
  AGENT_CONTROL_SERVICE_URL_ENV,
  invokeZerosComputerTool,
  invokeZerosDeviceTool,
  releaseZerosComputerUse,
  releaseZerosDeviceUse,
  reportNativeComputerUse,
  resolveAgentControlServiceConfig,
} from "../control-service-client";

const ENV = {
  [AGENT_CONTROL_SERVICE_URL_ENV]: "http://127.0.0.1:43124",
  [AGENT_CONTROL_SERVICE_TOKEN_ENV]: "control-secret",
};
const OWNER = { workspaceId: "workspace-1", conversationId: "conversation-1" };
const REQUEST = {
  owner: OWNER,
  agent: "claude" as const,
  turnId: "turn_6f1c1f9e-6c55-4c39-9c34-4c1f4a0f1d2e",
  tool: "screenshot" as const,
  arguments: { pid: 42 },
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function body(fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>, call = 0) {
  return JSON.parse(String(fetchImpl.mock.calls[call]?.[1]?.body));
}

describe("agent control service client", () => {
  afterEach(() => {
    delete process.env[AGENT_CONTROL_SERVICE_URL_ENV];
    delete process.env[AGENT_CONTROL_SERVICE_TOKEN_ENV];
    vi.resetModules();
  });

  it("captures the main-process capability and hides it from child processes", async () => {
    process.env[AGENT_CONTROL_SERVICE_URL_ENV] = ENV[AGENT_CONTROL_SERVICE_URL_ENV];
    process.env[AGENT_CONTROL_SERVICE_TOKEN_ENV] =
      ENV[AGENT_CONTROL_SERVICE_TOKEN_ENV];
    vi.resetModules();
    const client = await import("../control-service-client");
    expect(process.env[AGENT_CONTROL_SERVICE_URL_ENV]).toBeUndefined();
    expect(process.env[AGENT_CONTROL_SERVICE_TOKEN_ENV]).toBeUndefined();
    expect(client.resolveAgentControlServiceConfig()).toEqual({
      baseUrl: "http://127.0.0.1:43124",
      token: "control-secret",
    });
  });

  it("accepts only credential-free loopback service URLs", () => {
    expect(resolveAgentControlServiceConfig(ENV)).toEqual({
      baseUrl: "http://127.0.0.1:43124",
      token: "control-secret",
    });
    for (const url of [
      "https://example.com",
      "http://127.0.0.1:43124/hidden",
      "http://user:pass@127.0.0.1:43124",
    ]) {
      expect(
        resolveAgentControlServiceConfig({
          ...ENV,
          [AGENT_CONTROL_SERVICE_URL_ENV]: url,
        }),
      ).toBeNull();
    }
    expect(
      resolveAgentControlServiceConfig({
        [AGENT_CONTROL_SERVICE_URL_ENV]: ENV[AGENT_CONTROL_SERVICE_URL_ENV],
      }),
    ).toBeNull();
  });

  it("runs one computer tool in main with the bound owner, agent and turn", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      json({
        version: 1,
        success: true,
        content: [
          { type: "text", text: "TextEdit" },
          { type: "image", data: "AAAA", mimeType: "image/png" },
        ],
      }),
    );
    await expect(
      invokeZerosComputerTool(REQUEST, { env: ENV, fetchImpl }),
    ).resolves.toEqual({
      version: 1,
      success: true,
      content: [
        { type: "text", text: "TextEdit" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ],
    });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "http://127.0.0.1:43124/v1/computer/invoke",
    );
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: { authorization: "Bearer control-secret" },
    });
    expect(body(fetchImpl)).toEqual({ version: 1, ...REQUEST });
  });

  it("reads a result that main kept alive with leading whitespace", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          `   ${JSON.stringify({ version: 1, success: false, content: [{ type: "text", text: "Denied." }] })}`,
          { status: 200 },
        ),
    );
    await expect(
      invokeZerosComputerTool(REQUEST, { env: ENV, fetchImpl }),
    ).resolves.toEqual({
      version: 1,
      success: false,
      content: [{ type: "text", text: "Denied." }],
    });
  });

  it("refuses an unsafe request before contacting main", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    for (const request of [
      { ...REQUEST, owner: { ...OWNER, workspaceId: "../escape" } },
      { ...REQUEST, agent: "droid" as never },
      { ...REQUEST, turnId: "turn with spaces" },
      { ...REQUEST, tool: "run_script" as never },
    ]) {
      await expect(
        invokeZerosComputerTool(request, { env: ENV, fetchImpl }),
      ).rejects.toThrow("Invalid Zeros computer tool request");
    }
    await expect(
      invokeZerosComputerTool(REQUEST, { env: {}, fetchImpl }),
    ).rejects.toThrow(/Computer use is unavailable/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a malformed result, an oversized one and an HTTP error", async () => {
    await expect(
      invokeZerosComputerTool(REQUEST, {
        env: ENV,
        fetchImpl: vi.fn<typeof fetch>(async () =>
          json({
            version: 1,
            success: true,
            content: [{ type: "image", data: "AAAA", mimeType: "image/gif" }],
          }),
        ),
      }),
    ).rejects.toThrow("invalid computer result");
    await expect(
      invokeZerosComputerTool(REQUEST, {
        env: ENV,
        fetchImpl: vi.fn<typeof fetch>(
          async () =>
            new Response("{}", {
              headers: { "content-length": String(64 * 1024 * 1024) },
            }),
        ),
      }),
    ).rejects.toThrow("size limit");
    await expect(
      invokeZerosComputerTool(REQUEST, {
        env: ENV,
        fetchImpl: vi.fn<typeof fetch>(async () => json({}, 401)),
      }),
    ).rejects.toThrow("(401)");
  });

  it("aborts an in-flight call with the caller's signal", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal!.reason),
          );
        }),
    );
    const pending = invokeZerosComputerTool(REQUEST, {
      env: ENV,
      fetchImpl,
      signal: controller.signal,
    });
    controller.abort(new Error("stopped"));
    await expect(pending).rejects.toThrow("stopped");
  });

  it("releases the chat's control of the Mac", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      json({ version: 1, released: true }),
    );
    await expect(
      releaseZerosComputerUse(OWNER, "retire", { env: ENV, fetchImpl }),
    ).resolves.toBe(true);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "http://127.0.0.1:43124/v1/computer/release",
    );
    expect(body(fetchImpl)).toEqual({
      version: 1,
      owner: OWNER,
      reason: "retire",
    });

    await expect(
      releaseZerosComputerUse(
        { ...OWNER, conversationId: "a/b" },
        "stop",
        { env: ENV, fetchImpl },
      ),
    ).resolves.toBe(false);
    await expect(
      releaseZerosComputerUse(OWNER, "stop", { env: {}, fetchImpl }),
    ).resolves.toBe(false);
    expect(fetchImpl).toHaveBeenCalledOnce();

    await expect(
      releaseZerosComputerUse(OWNER, "stop", {
        env: ENV,
        fetchImpl: vi.fn<typeof fetch>(async () => json({ version: 1 })),
      }),
    ).rejects.toThrow("invalid release result");
  });

  it("runs one simulator tool in main and validates its result", async () => {
    const request = {
      owner: OWNER,
      agent: "codex" as const,
      turnId: REQUEST.turnId,
      tool: "tap" as const,
      arguments: { device_id: "FBF8387E-2D3A-4C47-9D0B-3E5F2A1B9C8D", ref: "@e3" },
    };
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      json({ version: 1, success: true, content: [{ type: "text", text: "Tapped Sign in." }] }),
    );
    await expect(
      invokeZerosDeviceTool(request, { env: ENV, fetchImpl }),
    ).resolves.toEqual({
      version: 1,
      success: true,
      content: [{ type: "text", text: "Tapped Sign in." }],
    });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "http://127.0.0.1:43124/v1/device/invoke",
    );
    expect(body(fetchImpl)).toEqual({ version: 1, ...request });

    await expect(
      invokeZerosDeviceTool(
        { ...request, tool: "erase_device" as never },
        { env: ENV, fetchImpl },
      ),
    ).rejects.toThrow("Invalid Zeros simulator tool request");
    await expect(
      invokeZerosDeviceTool(request, { env: {}, fetchImpl }),
    ).rejects.toThrow(/Simulators are unavailable/);
    expect(fetchImpl).toHaveBeenCalledOnce();
    await expect(
      invokeZerosDeviceTool(request, {
        env: ENV,
        fetchImpl: vi.fn<typeof fetch>(async () =>
          json({ version: 2, success: true, content: [] }),
        ),
      }),
    ).rejects.toThrow("invalid simulator result");
  });

  it("lets go of the chat's simulators", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      json({ version: 1, released: false }),
    );
    await expect(
      releaseZerosDeviceUse(OWNER, "retire", { env: ENV, fetchImpl }),
    ).resolves.toBe(false);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "http://127.0.0.1:43124/v1/device/release",
    );
    expect(body(fetchImpl)).toEqual({ version: 1, owner: OWNER, reason: "retire" });
    await expect(
      releaseZerosDeviceUse({ ...OWNER, workspaceId: "../x" }, "stop", {
        env: ENV,
        fetchImpl,
      }),
    ).resolves.toBe(false);
    await expect(
      releaseZerosDeviceUse(OWNER, "stop", { env: {}, fetchImpl }),
    ).resolves.toBe(false);
    expect(fetchImpl).toHaveBeenCalledOnce();
    await expect(
      releaseZerosDeviceUse(OWNER, "stop", {
        env: ENV,
        fetchImpl: vi.fn<typeof fetch>(async () => json({ released: true })),
      }),
    ).rejects.toThrow("invalid release result");
  });

  it("reports Codex's built-in computer use to main", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      json({ version: 1, accepted: true }),
    );
    await expect(
      reportNativeComputerUse(OWNER, "codex", true, { env: ENV, fetchImpl }),
    ).resolves.toBe(true);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "http://127.0.0.1:43124/v1/computer/native-activity",
    );
    expect(body(fetchImpl)).toEqual({
      version: 1,
      owner: OWNER,
      agent: "codex",
      active: true,
    });
    await expect(
      reportNativeComputerUse(OWNER, "codex", false, { env: {}, fetchImpl }),
    ).resolves.toBe(false);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
