import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ComputerToolInvokeRequest,
  ComputerToolResult,
} from "@zeros/protocol/computer-use-tools";
import type { DeviceToolInvokeRequest, DeviceToolResult } from "@zeros/protocol/device-tools";

import {
  startAgentControlService,
  type AgentControlComputerPort,
  type AgentControlDevicePort,
  type AgentControlServiceHandle,
} from "../agent-control/service";

const owner = { workspaceId: "ws_1", conversationId: "conv_a" };

function invokeBody(): ComputerToolInvokeRequest {
  return {
    version: 1,
    owner,
    agent: "claude",
    turnId: "turn_1",
    tool: "list_apps",
    arguments: {},
  } as ComputerToolInvokeRequest;
}

function done(text: string): ComputerToolResult {
  return { version: 1, success: true, content: [{ type: "text", text }] };
}

function fakeComputer(
  overrides: Partial<AgentControlComputerPort> = {},
): AgentControlComputerPort {
  return {
    invoke: vi.fn(async () => done("Apps")),
    release: vi.fn(() => true),
    nativeActivity: vi.fn(() => true),
    ...overrides,
  };
}

function deviceBody(): DeviceToolInvokeRequest {
  return {
    version: 1,
    owner,
    agent: "codex",
    turnId: "turn_1",
    tool: "list_devices",
    arguments: {},
  } as DeviceToolInvokeRequest;
}

function deviceDone(text: string): DeviceToolResult {
  return { version: 1, success: true, content: [{ type: "text", text }] };
}

function fakeDevice(overrides: Partial<AgentControlDevicePort> = {}): AgentControlDevicePort {
  return {
    invoke: vi.fn(async () => deviceDone("iOS simulators on this Mac:")),
    release: vi.fn(() => true),
    ...overrides,
  };
}

describe("agent control service", () => {
  let service: AgentControlServiceHandle | null = null;

  afterEach(async () => {
    await service?.stop();
    service = null;
  });

  async function post(
    path: string,
    body: unknown,
    init: { token?: string | null; signal?: AbortSignal; raw?: string } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    const token = init.token === undefined ? service!.token : init.token;
    if (token !== null) headers.authorization = `Bearer ${token}`;
    return fetch(`${service!.baseUrl}${path}`, {
      method: "POST",
      headers,
      body: init.raw ?? JSON.stringify(body),
      signal: init.signal,
    });
  }

  it("listens on loopback only and rejects requests without the token", async () => {
    const computer = fakeComputer();
    service = await startAgentControlService({ computer });
    expect(new URL(service.baseUrl).hostname).toBe("127.0.0.1");

    const missing = await post("/v1/computer/invoke", invokeBody(), {
      token: null,
    });
    expect(missing.status).toBe(401);
    const wrong = await post("/v1/computer/invoke", invokeBody(), {
      token: "x".repeat(service.token.length),
    });
    expect(wrong.status).toBe(401);
    expect(computer.invoke).not.toHaveBeenCalled();
  });

  it("forwards a computer call and answers with its result", async () => {
    const computer = fakeComputer();
    service = await startAgentControlService({ computer });

    const response = await post("/v1/computer/invoke", invokeBody());
    expect(response.status).toBe(200);
    expect(JSON.parse(await response.text())).toEqual(done("Apps"));
    expect(computer.invoke).toHaveBeenCalledWith(
      invokeBody(),
      expect.any(AbortSignal),
    );
  });

  it("keeps a slow answer alive and still parses as JSON", async () => {
    let finish!: (result: ComputerToolResult) => void;
    const computer = fakeComputer({
      invoke: vi.fn(
        () =>
          new Promise<ComputerToolResult>((resolve) => {
            finish = resolve;
          }),
      ),
    });
    service = await startAgentControlService({ computer, keepaliveMs: 5 });

    const response = await post("/v1/computer/invoke", invokeBody());
    expect(response.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 40));
    finish(done("Late"));
    const text = await response.text();
    expect(text.startsWith(" ")).toBe(true);
    expect(JSON.parse(text)).toEqual(done("Late"));
  });

  it("cancels the call when the engine gives up on it", async () => {
    let seen!: AbortSignal;
    const computer = fakeComputer({
      invoke: vi.fn(
        (_request: ComputerToolInvokeRequest, signal: AbortSignal) =>
          new Promise<ComputerToolResult>((resolve) => {
            seen = signal;
            signal.addEventListener("abort", () => resolve(done("Cancelled")));
          }),
      ),
    });
    service = await startAgentControlService({ computer });

    const abort = new AbortController();
    const response = await post("/v1/computer/invoke", invokeBody(), {
      signal: abort.signal,
    });
    expect(response.status).toBe(200);
    abort.abort();
    await vi.waitFor(() => expect(seen.aborted).toBe(true));
  });

  it("turns a thrown error into a failed result", async () => {
    const computer = fakeComputer({
      invoke: vi.fn(async () => {
        throw new Error("secret detail");
      }),
    });
    service = await startAgentControlService({ computer });

    const response = await post("/v1/computer/invoke", invokeBody());
    const result = JSON.parse(await response.text()) as ComputerToolResult;
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toContain("secret detail");
  });

  it("forwards turn ends and Codex's built-in activity", async () => {
    const computer = fakeComputer({ release: vi.fn(() => false) });
    service = await startAgentControlService({ computer });

    const released = await post("/v1/computer/release", {
      version: 1,
      owner,
      reason: "stop",
    });
    expect(await released.json()).toEqual({ version: 1, released: false });
    expect(computer.release).toHaveBeenCalledWith({
      version: 1,
      owner,
      reason: "stop",
    });

    const activity = await post("/v1/computer/native-activity", {
      version: 1,
      owner,
      agent: "codex",
      active: true,
    });
    expect(await activity.json()).toEqual({ version: 1, accepted: true });
    expect(computer.nativeActivity).toHaveBeenCalledWith({
      version: 1,
      owner,
      agent: "codex",
      active: true,
    });
  });

  it("rejects malformed, oversized and unknown requests", async () => {
    const computer = fakeComputer();
    service = await startAgentControlService({ computer });

    expect(
      (await post("/v1/computer/release", null, { raw: "{not json" })).status,
    ).toBe(400);
    expect((await post("/v1/computer/release", [1, 2])).status).toBe(400);
    expect(
      (
        await post("/v1/computer/release", null, {
          raw: JSON.stringify({ pad: "x".repeat(300 * 1024) }),
        })
      ).status,
    ).toBe(400);
    expect((await post("/v1/computer/elsewhere", {})).status).toBe(404);
    const get = await fetch(`${service.baseUrl}/v1/computer/invoke`, {
      headers: { authorization: `Bearer ${service.token}` },
    });
    expect(get.status).toBe(404);
    expect(computer.release).not.toHaveBeenCalled();
    expect(computer.invoke).not.toHaveBeenCalled();
  });

  it("forwards simulator calls and turn ends", async () => {
    const computer = fakeComputer();
    const device = fakeDevice();
    service = await startAgentControlService({ computer, device });

    const response = await post("/v1/device/invoke", deviceBody());
    expect(response.status).toBe(200);
    expect(JSON.parse(await response.text())).toEqual(
      deviceDone("iOS simulators on this Mac:"),
    );
    expect(device.invoke).toHaveBeenCalledWith(deviceBody(), expect.any(AbortSignal));

    const released = await post("/v1/device/release", { version: 1, owner, reason: "turn-end" });
    expect(await released.json()).toEqual({ version: 1, released: true });
    expect(device.release).toHaveBeenCalledWith({ version: 1, owner, reason: "turn-end" });
    expect(computer.invoke).not.toHaveBeenCalled();
    expect(computer.release).not.toHaveBeenCalled();
  });

  it("cancels a simulator call the engine gives up on and hides thrown errors", async () => {
    let seen!: AbortSignal;
    const device = fakeDevice({
      invoke: vi.fn(
        (_request: DeviceToolInvokeRequest, signal: AbortSignal) =>
          new Promise<DeviceToolResult>((resolve) => {
            seen = signal;
            signal.addEventListener("abort", () => resolve(deviceDone("Cancelled")));
          }),
      ),
    });
    service = await startAgentControlService({ computer: fakeComputer(), device });
    const abort = new AbortController();
    const response = await post("/v1/device/invoke", deviceBody(), { signal: abort.signal });
    expect(response.status).toBe(200);
    abort.abort();
    await vi.waitFor(() => expect(seen.aborted).toBe(true));

    vi.mocked(device.invoke).mockRejectedValueOnce(new Error("/Users/someone/secret"));
    const failed = JSON.parse(
      await (await post("/v1/device/invoke", deviceBody())).text(),
    ) as DeviceToolResult;
    expect(failed).toEqual({
      version: 1,
      success: false,
      content: [{ type: "text", text: "The simulator action failed." }],
    });
  });

  it("answers simulator calls without simulators", async () => {
    service = await startAgentControlService({ computer: fakeComputer() });

    const result = JSON.parse(await (await post("/v1/device/invoke", deviceBody())).text());
    expect(result).toEqual({
      version: 1,
      success: false,
      content: [{ type: "text", text: "Simulators are unavailable. Restart Zeros and try again." }],
    });
    const released = await post("/v1/device/release", { version: 1, owner, reason: "stop" });
    expect(await released.json()).toEqual({ version: 1, released: false });
  });

  it("aborts open calls when it stops", async () => {
    let seen!: AbortSignal;
    const computer = fakeComputer({
      invoke: vi.fn(
        (_request: ComputerToolInvokeRequest, signal: AbortSignal) =>
          new Promise<ComputerToolResult>((resolve) => {
            seen = signal;
            signal.addEventListener("abort", () => resolve(done("Stopped")));
          }),
      ),
    });
    service = await startAgentControlService({ computer });
    const pending = post("/v1/computer/invoke", invokeBody())
      .then((response) => response.text())
      .catch(() => "");
    await vi.waitFor(() => expect(computer.invoke).toHaveBeenCalled());
    await service.stop();
    expect(seen.aborted).toBe(true);
    await pending;
  });
});
