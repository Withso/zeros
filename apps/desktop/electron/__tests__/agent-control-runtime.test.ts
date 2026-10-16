import { describe, expect, it, vi } from "vitest";

import type { AgentControlConfirmationRequest } from "@zeros/protocol/agent-control";
import type { ComputerUseStateSnapshot } from "@zeros/protocol/computer-use-tools";

import type { AgentControlConfirmationInput } from "../agent-control/confirmations";
import {
  createAgentControlRuntime,
  type AgentControlRuntimeOptions,
} from "../agent-control/runtime";
import type { AgentControlServiceHandle } from "../agent-control/service";
import type { ComputerControlPanelHost } from "../computer-use/control-panel";

const OWNER = { workspaceId: "ws_1", conversationId: "conv_a" };

const SAFARI: AgentControlConfirmationInput = {
  kind: "app",
  ...OWNER,
  agent: "codex",
  subject: "Safari",
  subjectId: "com.apple.Safari",
} as AgentControlConfirmationInput;

function setup(overrides: Partial<AgentControlRuntimeOptions> = {}) {
  const requests: AgentControlConfirmationRequest[] = [];
  const settled: string[] = [];
  const states: ComputerUseStateSnapshot[] = [];
  const panel = {
    show: vi.fn(),
    hide: vi.fn(),
    withoutEscape: <T,>(work: () => Promise<T>) => work(),
    dispose: vi.fn(),
  } satisfies ComputerControlPanelHost;
  let panelStop: (() => void) | null = null;
  const service: AgentControlServiceHandle = {
    baseUrl: "http://127.0.0.1:4100",
    token: "control-token",
    stop: vi.fn(async () => undefined),
  };
  const host = {
    openSession: vi.fn(async () => {
      throw new Error("not used");
    }),
    stop: vi.fn(async () => undefined),
  };
  const permissions = {
    status: vi.fn(() => ({ accessibility: true, screenRecording: false })),
    request: vi.fn(async () => ({ accessibility: true, screenRecording: true })),
    openSettings: vi.fn(async () => undefined),
  };
  const startService = vi.fn(async () => service);
  const runtime = createAgentControlRuntime({
    platform: "darwin",
    selfPid: 4_242,
    host,
    permissions,
    createPanel: (onStop) => {
      panelStop = onStop;
      return panel;
    },
    driverInstalled: () => true,
    isTrustedSurfaceAvailable: () => true,
    onConfirmationRequest: (request) => requests.push(request),
    onConfirmationSettled: (id) => settled.push(id),
    onComputerState: (state) => states.push(state),
    startService,
    ...overrides,
  });
  return {
    runtime,
    requests,
    settled,
    states,
    panel,
    panelStop: () => panelStop?.(),
    service,
    host,
    permissions,
    startService,
  };
}

describe("agent control in Electron main", () => {
  it("serves the engine on macOS only", async () => {
    const mac = setup();
    await expect(mac.runtime.ready).resolves.toBe(mac.service);
    expect(mac.startService).toHaveBeenCalledWith({
      computer: mac.runtime.computer,
    });

    const linux = setup({ platform: "linux" });
    await expect(linux.runtime.ready).resolves.toBeNull();
    expect(linux.startService).not.toHaveBeenCalled();
  });

  it("keeps the app running when the service cannot start", async () => {
    const log = vi.fn();
    const { runtime } = setup({
      startService: vi.fn(async () => {
        throw new Error("EADDRINUSE");
      }),
      log,
    });
    await expect(runtime.ready).resolves.toBeNull();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("agent control service unavailable"),
    );
  });

  it("asks the trusted window for approvals and denies without one", async () => {
    const shown = setup();
    const pending = shown.runtime.confirmations.confirm(SAFARI);
    expect(shown.requests).toHaveLength(1);
    expect(shown.requests[0]).toMatchObject({ subject: "Safari", agent: "codex" });
    expect(
      shown.runtime.confirmations.respond(shown.requests[0]!.id, "allow"),
    ).toBe(true);
    await expect(pending).resolves.toBe("allow");
    expect(shown.settled).toEqual([shown.requests[0]!.id]);

    const hidden = setup({ isTrustedSurfaceAvailable: () => false });
    await expect(hidden.runtime.confirmations.confirm(SAFARI)).resolves.toBe(
      "deny",
    );
    expect(hidden.requests).toEqual([]);
  });

  it("denies a chat's open approvals when its turn ends", async () => {
    const { runtime } = setup();
    const pending = runtime.confirmations.confirm(SAFARI);
    const other = runtime.confirmations.confirm({
      ...SAFARI,
      conversationId: "conv_b",
    } as AgentControlConfirmationInput);
    runtime.computer.release({ version: 1, owner: OWNER, reason: "turn-end" });
    await expect(pending).resolves.toBe("deny");
    expect(runtime.confirmations.pendingRequests()).toHaveLength(1);
    runtime.revokeConfirmationSurface();
    await expect(other).resolves.toBe("deny");
  });

  it("sends who holds the computer to the renderer", () => {
    const { runtime, states } = setup();
    runtime.computer.nativeActivity({
      version: 1,
      owner: OWNER,
      agent: "codex",
      active: true,
    });
    expect(states.at(-1)?.holders).toEqual([
      { ...OWNER, agent: "codex", app: null, native: true },
    ]);
    expect(runtime.computer.state().holders).toHaveLength(1);
  });

  it("stops the computer when the user presses Stop or Esc on the bar", () => {
    const { runtime, panelStop } = setup();
    const stop = vi.spyOn(runtime.computer, "stopFromUser");
    panelStop();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("reports availability and live macOS grants for Settings", async () => {
    const { runtime, permissions } = setup();
    expect(runtime.computerStatus()).toEqual({
      version: 1,
      available: true,
      accessibility: true,
      screenRecording: false,
    });
    permissions.status.mockReturnValue({
      accessibility: true,
      screenRecording: true,
    });
    await expect(runtime.requestComputerPermissions()).resolves.toMatchObject({
      accessibility: true,
      screenRecording: true,
    });
    expect(permissions.request).toHaveBeenCalledTimes(1);

    expect(
      setup({ driverInstalled: () => false }).runtime.computerStatus().available,
    ).toBe(false);
    expect(setup({ platform: "linux" }).runtime.computerStatus().available).toBe(
      false,
    );
  });

  it("still answers Settings when macOS cannot be asked", async () => {
    const log = vi.fn();
    const { runtime, permissions } = setup({ log });
    permissions.request.mockRejectedValue(new Error("SDK missing"));
    await expect(runtime.requestComputerPermissions()).resolves.toMatchObject({
      version: 1,
      accessibility: true,
    });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("could not ask macOS"),
    );
  });

  it("releases everything on quit", async () => {
    const { runtime, service, panel, host } = setup();
    await runtime.ready;
    const pending = runtime.confirmations.confirm(SAFARI);
    await runtime.stop();
    await expect(pending).resolves.toBe("deny");
    expect(service.stop).toHaveBeenCalledTimes(1);
    expect(panel.dispose).toHaveBeenCalledTimes(1);
    expect(host.stop).toHaveBeenCalledTimes(1);
    await runtime.stop();
    expect(service.stop).toHaveBeenCalledTimes(1);
    await expect(
      runtime.computer.invoke({
        version: 1,
        owner: OWNER,
        agent: "codex",
        turnId: "turn_1",
        tool: "list_apps",
        arguments: {},
      }),
    ).resolves.toMatchObject({ success: false });
  });

  it("serves simulator use through the same approvals", async () => {
    const phone = {
      id: "11111111-1111-4111-8111-111111111111",
      platform: "ios",
      name: "iPhone 17",
      osLabel: "iOS 26.2",
      formFactor: "phone",
      state: "booted",
      bootedByZeros: false,
    };
    const snapshot = {
      version: 1,
      devices: [phone],
      setup: [{ platform: "ios", state: "ready", toolLabel: "Xcode 26", download: null }],
      idleWarnings: [],
    };
    const hub = {
      state: vi.fn(() => snapshot),
      refresh: vi.fn(async () => snapshot),
      preferences: vi.fn(() => ({
        agentsEnabled: true,
        idleShutdown: "30m",
        showAgentTouches: true,
      })),
      boot: vi.fn(async () => "booted"),
      cancelBoot: vi.fn(() => true),
      input: vi.fn(async () => undefined),
      setAppearance: vi.fn(async () => undefined),
      rotate: vi.fn(async () => undefined),
      hold: vi.fn(() => () => undefined),
    };
    const deviceStates: unknown[] = [];
    const { runtime, requests, startService } = setup({
      devices: {
        hub: hub as never,
        automation: null,
        onState: (state) => deviceStates.push(state),
        onTouch: vi.fn(),
      },
    });
    await runtime.ready;
    expect(runtime.devices).not.toBeNull();
    expect(startService).toHaveBeenCalledWith({
      computer: runtime.computer,
      device: runtime.devices,
    });

    const call = runtime.devices!.invoke({
      version: 1,
      owner: OWNER,
      agent: "claude",
      turnId: "turn_1",
      tool: "press_button",
      arguments: { device_id: phone.id, button: "home" },
    } as never);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({ kind: "device", subject: "iPhone 17" });
    runtime.confirmations.respond(requests[0]!.id, "allow");
    await expect(call).resolves.toMatchObject({ success: true });
    expect(deviceStates.at(-1)).toEqual({
      version: 1,
      holders: [
        { ...OWNER, agent: "claude", deviceId: phone.id, deviceName: "iPhone 17", platform: "ios" },
      ],
    });

    await runtime.stop();
    expect(deviceStates.at(-1)).toEqual({ version: 1, holders: [] });
    await expect(
      runtime.devices!.invoke({
        version: 1,
        owner: OWNER,
        agent: "claude",
        turnId: "turn_2",
        tool: "list_devices",
        arguments: {},
      } as never),
    ).resolves.toMatchObject({ success: false });

    expect(setup().runtime.devices).toBeNull();
  });

  it("closes a service that finishes starting after quit", async () => {
    let finish: (handle: AgentControlServiceHandle) => void = () => undefined;
    const late: AgentControlServiceHandle = {
      baseUrl: "http://127.0.0.1:4101",
      token: "late-token",
      stop: vi.fn(async () => undefined),
    };
    const { runtime } = setup({
      startService: vi.fn(
        () =>
          new Promise<AgentControlServiceHandle>((resolve) => {
            finish = resolve;
          }),
      ),
    });
    const stopped = runtime.stop();
    finish(late);
    await stopped;
    await expect(runtime.ready).resolves.toBeNull();
    expect(late.stop).toHaveBeenCalledTimes(1);
  });
});
