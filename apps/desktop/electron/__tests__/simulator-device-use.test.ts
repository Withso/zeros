import { describe, expect, it, vi } from "vitest";

import type {
  DeviceAgentTouch,
  DeviceToolInvokeRequest,
  DeviceToolResult,
  DeviceUseStateSnapshot,
} from "@zeros/protocol/device-tools";
import type {
  SimulatorBootOutcome,
  SimulatorDevice,
  SimulatorHubSnapshot,
  SimulatorInput,
  SimulatorPreferences,
  SimulatorScreen,
  SimulatorSetupStatus,
} from "@zeros/protocol/simulators";

import { failureReply, type AgentDeviceCommand, type AgentDeviceReply } from "../devices/agent-device";
import { DeviceActionError } from "../devices/device-hub";
import {
  DeviceUseController,
  agentDeviceOrientation,
  agentDevicePinch,
  type DeviceAutomation,
  type DeviceScreenPort,
  type DeviceUseHub,
} from "../devices/device-use-controller";
import type { RecordedAction } from "../devices/recording-timeline";

const PHONE = "FBF8387E-9B7A-4F2A-9ACE-6BDF338E0108";
const PAD = "3C744E00-19C9-4872-8106-A474ADDDFA96";
const SPARE = "11111111-1111-4111-8111-111111111111";
const PIXEL = "Pixel_9_API_37";
const APP = "/Users/someone/DerivedData/Build/Products/Debug-iphonesimulator/My App.app";
const APK = "/Users/someone/app/build/outputs/apk/debug/app-debug.apk";
const IPHONE_SCREEN: SimulatorScreen = { widthPx: 1206, heightPx: 2622, scale: 3, cornerRadius: 62 };
const PIXEL_SCREEN: SimulatorScreen = { widthPx: 1080, heightPx: 2424, scale: 2.625, cornerRadius: 33 };

function device(
  id: string,
  name: string,
  state: SimulatorDevice["state"],
  extra: Partial<SimulatorDevice> = {},
): SimulatorDevice {
  return {
    id,
    platform: "ios",
    name,
    osLabel: "iOS 27.0",
    formFactor: name.startsWith("iPad") ? "tablet" : "phone",
    state,
    bootedByZeros: false,
    ...extra,
  };
}

function fakeHub(options: { android?: boolean } = {}) {
  const devices: SimulatorDevice[] = [
    device(PHONE, "iPhone 17", "booted"),
    device(PAD, "iPad Pro 13-inch (M5)", "booted"),
    device(SPARE, "iPhone 16e", "shutdown"),
    ...(options.android
      ? [device(PIXEL, "Pixel 9", "booted", { platform: "android", osLabel: "Android 17" })]
      : []),
  ];
  const preferences: SimulatorPreferences = {
    agentsEnabled: true,
    idleShutdown: "30m",
    showAgentTouches: true,
  };
  const setup: SimulatorSetupStatus[] = [
    { platform: "ios", state: "ready", toolLabel: "Xcode 27.0", download: null },
  ];
  let holds = 0;
  const snapshot = (): SimulatorHubSnapshot => ({
    version: 1,
    devices: devices.map((entry) => ({ ...entry })),
    setup: setup.map((entry) => ({ ...entry })),
    idleWarnings: [],
  });
  const find = (id: string) => devices.find((entry) => entry.id === id);
  const hub = {
    state: vi.fn(snapshot),
    refresh: vi.fn(async () => snapshot()),
    preferences: vi.fn(() => ({ ...preferences })),
    deviceScreen: vi.fn(async (id: string): Promise<SimulatorScreen | null> =>
      find(id)?.platform === "android" ? PIXEL_SCREEN : IPHONE_SCREEN,
    ),
    boot: vi.fn(async (id: string): Promise<SimulatorBootOutcome> => {
      const entry = find(id);
      if (entry) entry.state = "booted";
      return "booted";
    }),
    cancelBoot: vi.fn(() => true),
    canDrive: vi.fn((id: string) => find(id)?.state === "booted"),
    input: vi.fn(async (_id: string, _input: SimulatorInput) => undefined),
    setAppearance: vi.fn(async () => undefined),
    rotate: vi.fn(async (id: string, orientation: SimulatorDevice["orientation"]) => {
      const entry = find(id);
      if (!entry) return;
      if (orientation === "portrait") delete entry.orientation;
      else entry.orientation = orientation;
    }),
    hold: vi.fn(() => {
      holds += 1;
      let released = false;
      return () => {
        if (!released) holds -= 1;
        released = true;
      };
    }),
  };
  return {
    hub,
    devices,
    preferences,
    setup,
    find,
    snapshot,
    holds: () => holds,
  };
}

const OK: AgentDeviceReply = { ok: true, data: {} };

interface Recorded {
  udid: string;
  command: AgentDeviceCommand;
  signal: AbortSignal | undefined;
}

function fakeAutomation(
  answer: (command: AgentDeviceCommand, signal: AbortSignal | undefined) =>
    | AgentDeviceReply
    | Promise<AgentDeviceReply> = () => OK,
) {
  const runs: Recorded[] = [];
  const automation = {
    run: vi.fn(async (udid: string, command: AgentDeviceCommand, signal?: AbortSignal) => {
      runs.push({ udid, command, signal });
      return answer(command, signal);
    }),
    openTarget: vi.fn(
      async (_udid: string, _target: string, _options?: { relaunch?: boolean }) =>
        ({ ok: true, data: { appBundleId: "com.apple.mobilesafari" } }) as AgentDeviceReply,
    ),
    screenshot: vi.fn(async () => ({
      ok: true as const,
      png: Buffer.from("png-bytes"),
      data: { width: 402, height: 874, displayRotation: "portrait" },
    })),
  };
  return { automation, runs };
}

/** Time that passes only when the controller sleeps or a test says so. */
function testClock() {
  let now = 10_000;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/** Zeros's own reads of a screen, which stays still for as long as `still`
 * says at each moment, or has no live view when it says null. */
function fakeScreen(time: () => number) {
  let still: (now: number) => number | null = () => null;
  const reads: number[] = [];
  const port = {
    image: vi.fn(
      async (_id: string, _size: { width: number; height: number }): Promise<Buffer | null> => {
        reads.push(time());
        return Buffer.from("own-png");
      },
    ),
    stillFor: vi.fn((_id: string) => still(time())),
  };
  return {
    port,
    reads,
    stillFor: (answer: (now: number) => number | null) => {
      still = answer;
    },
  };
}

function setup(
  options: {
    decision?: "allow" | "deny";
    answer?: Parameters<typeof fakeAutomation>[0];
    automation?: false;
    inspectAppBundle?: (path: string) => Promise<string | null>;
    android?: boolean;
    available?: () => boolean;
    /** Zeros reads the screen itself. */
    ownScreen?: boolean;
  } = {},
) {
  const hub = fakeHub({ android: options.android === true });
  const { automation, runs } = fakeAutomation(options.answer);
  const confirm = vi.fn(async (_input: unknown, _signal: AbortSignal) => options.decision ?? "allow");
  const denyConfirmations = vi.fn();
  const states: DeviceUseStateSnapshot[] = [];
  const touches: DeviceAgentTouch[] = [];
  const actions: Array<[string, string, RecordedAction]> = [];
  const clock = testClock();
  const sleep = vi.fn(async (ms: number) => clock.advance(ms));
  const screen = fakeScreen(clock.now);
  const controller = new DeviceUseController({
    hub: hub.hub as unknown as DeviceUseHub,
    automation: options.automation === false ? null : (automation as unknown as DeviceAutomation),
    confirm: confirm as never,
    denyConfirmations,
    onState: (state) => states.push(state),
    onTouch: (touch) => touches.push(touch),
    onAction: (deviceId, agent, action) => actions.push([deviceId, agent, action]),
    sleep,
    now: clock.now,
    ...(options.inspectAppBundle ? { inspectAppBundle: options.inspectAppBundle } : {}),
    ...(options.available ? { available: options.available } : {}),
    ...(options.ownScreen ? { screen: screen.port satisfies DeviceScreenPort } : {}),
  });
  return {
    controller,
    hub,
    automation,
    runs,
    confirm,
    denyConfirmations,
    states,
    touches,
    actions,
    sleep,
    screen,
    time: clock.now,
    advance: clock.advance,
  };
}

function request(
  tool: DeviceToolInvokeRequest["tool"],
  args: Record<string, unknown>,
  overrides: Partial<DeviceToolInvokeRequest> & { conversationId?: string } = {},
): DeviceToolInvokeRequest {
  const { conversationId = "conv_a", ...rest } = overrides;
  return {
    version: 1,
    owner: { workspaceId: "ws_1", conversationId },
    agent: "codex",
    turnId: "turn_1",
    tool,
    arguments: args as never,
    ...rest,
  };
}

function text(result: DeviceToolResult): string {
  return result.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

describe("simulator use by agents", () => {
  it("lists simulators without asking, and says which another chat is using", async () => {
    const { controller, hub, confirm } = setup();
    hub.find(PAD)!.orientation = "landscape-left";
    await controller.invoke(request("tap", { device_id: PHONE, x: 10, y: 20 }, { conversationId: "conv_b" }));
    confirm.mockClear();
    const result = await controller.invoke(request("list_devices", {}));
    expect(result.success).toBe(true);
    expect(text(result)).toBe(
      [
        "Simulators on this Mac:",
        `- iPhone 17 (iOS 27.0), running, in use by another chat, ID ${PHONE}`,
        `- iPad Pro 13-inch (M5) (iOS 27.0), running, turned landscape-left, ID ${PAD}`,
        `- iPhone 16e (iOS 27.0), not running, ID ${SPARE}`,
      ].join("\n"),
    );
    expect(hub.hub.refresh).toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();

    hub.devices.splice(0);
    expect(text(await controller.invoke(request("list_devices", {})))).toBe(
      "This Mac has no simulators yet. The user can add an iOS simulator in Xcode.",
    );
  });

  it("says what each platform lacks when there are no simulators", async () => {
    const { controller, hub } = setup();
    hub.devices.splice(0);
    const ios = hub.setup[0]!;
    const list = async () => text(await controller.invoke(request("list_devices", {})));
    ios.state = "tools-missing";
    hub.setup.push({
      platform: "android",
      state: "ready",
      toolLabel: "Android Emulator 36.1",
      download: null,
      newDevice: "Pixel 10 with Android 17",
      studioInstalled: true,
    });
    expect(await list()).toBe(
      "This Mac has no simulators yet. Xcode isn't installed, so there are no iOS simulators. The user can create an Android simulator from a Simulator tab.",
    );
    ios.state = "runtime-missing";
    hub.setup[1] = { platform: "android", state: "tools-missing", toolLabel: null, download: null, studioInstalled: false };
    expect(await list()).toBe(
      "This Mac has no simulators yet. Xcode has no iOS runtime yet; the user can install one from a Simulator tab. Android Studio isn't installed, so there are no Android simulators.",
    );
    hub.setup[1] = { platform: "android", state: "runtime-missing", toolLabel: null, download: null, studioInstalled: true };
    expect(await list()).toContain("Android Studio has no Android system image yet.");
    hub.setup[1] = { platform: "android", state: "tools-missing", toolLabel: null, download: null, studioInstalled: true };
    expect(await list()).toContain("Android Studio is installed without the Android Emulator.");
    hub.setup[1] = { platform: "android", state: "ready", toolLabel: null, download: null, newDevice: null };
    expect(await list()).toContain("The user can add an Android simulator in Android Studio.");
    ios.state = "unsupported";
    expect(await list()).toBe("Simulators need a Mac.");
  });

  it("asks once per simulator per chat, before anything reaches it", async () => {
    const { controller, confirm, runs } = setup();
    await controller.invoke(request("tap", { device_id: PHONE, x: 10, y: 20 }));
    await controller.invoke(request("tap", { device_id: PHONE, ref: "@e3" }, { turnId: "turn_2" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]?.[0]).toEqual({
      kind: "device",
      workspaceId: "ws_1",
      conversationId: "conv_a",
      agent: "codex",
      subject: "iPhone 17",
      subjectId: PHONE,
    });
    expect(runs).toHaveLength(2);

    await controller.invoke(request("tap", { device_id: PAD, x: 10, y: 20 }));
    expect(confirm).toHaveBeenCalledTimes(2);
    controller.release({ version: 1, owner: { workspaceId: "ws_1", conversationId: "conv_a" }, reason: "turn-end" });
    await controller.invoke(request("tap", { device_id: PHONE, x: 1, y: 2 }, { conversationId: "conv_b" }));
    expect(confirm).toHaveBeenCalledTimes(3);
  });

  it("asks once when a chat's first calls arrive together", async () => {
    let allow: (decision: "allow") => void = () => undefined;
    const { controller, confirm, runs } = setup();
    confirm.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          allow = resolve;
        }),
    );
    const first = controller.invoke(request("tap", { device_id: PHONE, x: 10, y: 20 }));
    const second = controller.invoke(request("snapshot", { device_id: PHONE }));
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    allow("allow");
    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.success)).toEqual([true, true]);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(runs.map((run) => run.command.name)).toEqual(["press", "snapshot"]);
  });

  it("refuses the rest of the turn after a denial without asking again", async () => {
    const { controller, confirm, runs } = setup({ decision: "deny" });
    const denied = await controller.invoke(request("tap", { device_id: PHONE, x: 10, y: 20 }));
    expect(denied).toMatchObject({ success: false });
    expect(text(denied)).toBe("The user did not allow Codex to use iPhone 17.");
    expect(text(await controller.invoke(request("snapshot", { device_id: PHONE })))).toBe(
      "The user did not allow Codex to use iPhone 17.",
    );
    expect(confirm).toHaveBeenCalledTimes(1);
    await controller.invoke(request("snapshot", { device_id: PHONE }, { turnId: "turn_2" }));
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(runs).toHaveLength(0);
  });

  it("forgets a chat's approvals when the chat is retired", async () => {
    const { controller, confirm, denyConfirmations } = setup();
    await controller.invoke(request("tap", { device_id: PHONE, x: 10, y: 20 }));
    expect(
      controller.release({ version: 1, owner: { workspaceId: "ws_1", conversationId: "conv_a" }, reason: "retire" }),
    ).toBe(true);
    expect(denyConfirmations).toHaveBeenCalledWith("ws_1", "conv_a");
    expect(
      controller.release({ version: 1, owner: { workspaceId: "ws_1", conversationId: "conv_a" }, reason: "turn-end" }),
    ).toBe(false);
    await controller.invoke(request("tap", { device_id: PHONE, x: 10, y: 20 }, { turnId: "turn_2" }));
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("asks before every boot, and an allowed boot also allows using the simulator", async () => {
    const { controller, hub, confirm, states } = setup();
    const booted = await controller.invoke(request("boot_device", { device_id: SPARE }));
    expect(text(booted)).toBe("iPhone 16e is running. Zeros shows it in a Simulator tab.");
    expect(confirm.mock.calls[0]?.[0]).toMatchObject({ kind: "device-boot", subject: "iPhone 16e", subjectId: SPARE });
    expect(hub.hub.boot).toHaveBeenCalledWith(SPARE);
    expect(states.at(-1)?.holders).toEqual([
      {
        workspaceId: "ws_1",
        conversationId: "conv_a",
        agent: "codex",
        deviceId: SPARE,
        deviceName: "iPhone 16e",
        platform: "ios",
      },
    ]);
    await controller.invoke(request("tap", { device_id: SPARE, x: 10, y: 20 }));
    expect(confirm).toHaveBeenCalledTimes(1);

    expect(text(await controller.invoke(request("boot_device", { device_id: SPARE })))).toBe(
      "iPhone 16e is already running.",
    );
    hub.find(SPARE)!.state = "shutdown";
    await controller.invoke(request("boot_device", { device_id: SPARE }, { turnId: "turn_2" }));
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm.mock.calls[1]?.[0]).toMatchObject({ kind: "device-boot" });
  });

  it("doesn't boot when the user says no, and doesn't ask again that turn", async () => {
    const { controller, hub, confirm, states } = setup({ decision: "deny" });
    const result = await controller.invoke(request("boot_device", { device_id: SPARE }));
    expect(text(result)).toBe("The user did not allow Codex to start iPhone 16e.");
    await controller.invoke(request("boot_device", { device_id: SPARE }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(hub.hub.boot).not.toHaveBeenCalled();
    expect(states.at(-1)?.holders ?? []).toEqual([]);
  });

  it("cancels a boot it started when the chat stops, but never one the user started", async () => {
    const { controller, hub } = setup();
    let finish: (outcome: "booted" | "cancelled") => void = () => undefined;
    hub.hub.boot.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    hub.hub.cancelBoot.mockImplementationOnce(() => {
      finish("cancelled");
      return true;
    });
    const pending = controller.invoke(request("boot_device", { device_id: SPARE }));
    await vi.waitFor(() => expect(hub.hub.boot).toHaveBeenCalled());
    controller.release({ version: 1, owner: { workspaceId: "ws_1", conversationId: "conv_a" }, reason: "stop" });
    expect(text(await pending)).toBe("The simulator action was cancelled.");
    expect(hub.hub.cancelBoot).toHaveBeenCalledWith(SPARE);

    hub.find(PAD)!.state = "booting";
    let userBoot: (outcome: "booted") => void = () => undefined;
    hub.hub.boot.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          userBoot = resolve;
        }),
    );
    const abort = new AbortController();
    const waiting = controller.invoke(request("boot_device", { device_id: PAD }, { turnId: "turn_2" }), abort.signal);
    await vi.waitFor(() => expect(hub.hub.boot).toHaveBeenCalledTimes(2));
    abort.abort();
    expect(text(await waiting)).toBe("The simulator action was cancelled.");
    expect(hub.hub.cancelBoot).toHaveBeenCalledTimes(1);
    userBoot("booted");
  });

  it("lets one chat use a simulator at a time, and frees it when the turn ends", async () => {
    const { controller, confirm, runs } = setup();
    await controller.invoke(request("tap", { device_id: PHONE, x: 10, y: 20 }));
    const busy = await controller.invoke(
      request("tap", { device_id: PHONE, x: 10, y: 20 }, { conversationId: "conv_b" }),
    );
    expect(text(busy)).toBe(
      "Another chat is using iPhone 17. Use another simulator, or try again when that chat finishes.",
    );
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(
      (await controller.invoke(request("tap", { device_id: PAD, x: 1, y: 1 }, { conversationId: "conv_b" }))).success,
    ).toBe(true);
    expect(controller.state().holders.map((holder) => [holder.conversationId, holder.deviceId])).toEqual([
      ["conv_a", PHONE],
      ["conv_b", PAD],
    ]);
    expect(
      controller.release({ version: 1, owner: { workspaceId: "ws_1", conversationId: "conv_a" }, reason: "turn-end" }),
    ).toBe(true);
    expect(
      (await controller.invoke(request("tap", { device_id: PHONE, x: 1, y: 1 }, { conversationId: "conv_b" }))).success,
    ).toBe(true);
    expect(runs).toHaveLength(3);
  });

  it("stops at once when the user presses Stop, and refuses the rest of that turn there", async () => {
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { controller, runs, hub } = setup({
      answer: (command, signal) =>
        command.name === "press"
          ? new Promise((resolve) => {
              started();
              signal?.addEventListener("abort", () => resolve(failureReply("ABORTED")), { once: true });
            })
          : OK,
    });
    const pending = controller.invoke(request("tap", { device_id: PHONE, x: 10, y: 20 }));
    await running;
    expect(controller.stopFromUser(PHONE)).toBe(true);
    const stopped =
      "The user stopped you on iPhone 17. Don't use it again until the user asks.";
    expect(text(await pending)).toBe(stopped);
    expect(text(await controller.invoke(request("snapshot", { device_id: PHONE })))).toBe(stopped);
    expect(controller.state().holders).toEqual([]);
    expect(hub.holds()).toBe(0);
    expect((await controller.invoke(request("snapshot", { device_id: PAD }))).success).toBe(true);
    expect((await controller.invoke(request("snapshot", { device_id: PHONE }, { turnId: "turn_2" }))).success).toBe(
      true,
    );
    expect(runs.map((run) => run.command.name)).toEqual(["press", "snapshot", "snapshot"]);
    expect(controller.stopFromUser(SPARE)).toBe(false);
  });

  it("maps every tool onto agent-device or DeviceHub, holding the device off idle shutdown meanwhile", async () => {
    const inspectAppBundle = vi.fn(async () => null);
    const { controller, hub, automation, runs } = setup({
      inspectAppBundle,
      answer: (command) => {
        if (command.name === "apps") return { ok: true, data: { apps: ["My App (com.example.my-app)"] } };
        if (command.name === "install") {
          return { ok: true, data: { appName: "My App", bundleId: "com.example.my-app" } };
        }
        if (command.name === "scroll") return { ok: true, data: { movement: "at-edge" } };
        return OK;
      },
    });
    const call = async (tool: DeviceToolInvokeRequest["tool"], args: Record<string, unknown>) => {
      const result = await controller.invoke(request(tool, { device_id: PHONE, ...args }));
      expect(hub.holds()).toBe(0);
      return text(result);
    };
    expect(await call("list_apps", { all: true })).toBe("Apps on iPhone 17:\n- My App (com.example.my-app)");
    expect(await call("install_app", { path: APP })).toBe(
      "Installed My App (com.example.my-app) on iPhone 17. Open it with launch_app.",
    );
    expect(inspectAppBundle).toHaveBeenCalledWith(APP);
    expect(await call("launch_app", { bundle_id: "com.example.my-app", relaunch: true })).toBe(
      "Opened com.example.my-app on iPhone 17.",
    );
    expect(await call("open_url", { url: "https://example.com/a" })).toBe(
      "Opened https://example.com/a in com.apple.mobilesafari.",
    );
    await call("snapshot", {});
    await call("snapshot", { all: true });
    expect(await call("tap", { ref: "@e3" })).toBe("Tapped @e3.");
    expect(await call("tap", { x: 10.4, y: 20, count: 2 })).toBe("Double-tapped 10, 20.");
    expect(await call("tap", { ref: "@e4", hold_ms: 800 })).toBe("Long-pressed @e4 for 800 ms.");
    expect(await call("type_text", { text: "hello" })).toBe("Typed 5 characters.");
    expect(await call("type_text", { text: "new value", ref: "@e5" })).toBe("Replaced the text of @e5.");
    expect(await call("type_text", { text: "", ref: "@e5" })).toBe("Cleared @e5.");
    expect(await call("swipe", { from_x: 10, from_y: 20, to_x: 30, to_y: 400 })).toBe(
      "Swiped from 10, 20 to 30, 400.",
    );
    await call("swipe", { from_x: 100, from_y: 500, to_x: 100, to_y: 200, duration_ms: 600 });
    expect(await call("scroll", { direction: "down", amount: 0.5 })).toBe(
      "Scrolled down to the end of the content.",
    );
    expect(await call("pinch", { scale: 2, x: 100, y: 200 })).toBe("Zoomed in to 2×.");
    await call("pinch", { scale: 0.5 });
    expect(runs.map((run) => [run.udid, run.command])).toEqual(
      [
        { name: "apps", flags: ["--all"] },
        { name: "install", operands: [APP] },
        { name: "snapshot", flags: ["-i"], followFront: true },
        { name: "snapshot", followFront: true },
        { name: "press", operands: ["@e3"], followFront: true },
        { name: "press", flags: ["--double-tap"], operands: ["10", "20"], followFront: true },
        { name: "longpress", operands: ["@e4", "800"], followFront: true },
        { name: "type", operands: ["hello"], followFront: true },
        { name: "fill", flags: ["--text-stdin"], operands: ["@e5"], stdin: "new value\n", followFront: true },
        { name: "fill", flags: ["--text-stdin"], operands: ["@e5"], stdin: "\n", followFront: true },
        { name: "swipe", operands: ["10", "20", "30", "400"], followFront: true },
        { name: "gesture", operands: ["pan", "100", "500", "0", "-300", "600"], followFront: true },
        { name: "scroll", operands: ["down", "0.5"], followFront: true },
        { name: "gesture", operands: ["pinch", "2", "100", "200"], followFront: true },
        { name: "gesture", operands: ["pinch", "0.5"], followFront: true },
      ].map((command) => [PHONE, command]),
    );
    expect(automation.openTarget.mock.calls.map((args) => args.slice(0, 3))).toEqual([
      [PHONE, "com.example.my-app", { relaunch: true }],
      [PHONE, "https://example.com/a", {}],
    ]);

    expect(await call("press_key", { key: "enter" })).toBe("Pressed enter.");
    expect(await call("press_button", { button: "home" })).toBe("Pressed Home.");
    expect(await call("rotate", { orientation: "landscape-left" })).toBe(
      "Rotated iPhone 17 to landscape-left.",
    );
    expect(await call("set_appearance", { appearance: "dark" })).toBe("iPhone 17 now uses dark appearance.");
    expect(hub.hub.input.mock.calls).toEqual([
      [PHONE, { kind: "key", key: "enter" }],
      [PHONE, { kind: "button", button: "home" }],
    ]);
    expect(hub.hub.rotate).toHaveBeenCalledWith(PHONE, "landscape-left");
    expect(hub.hub.setAppearance).toHaveBeenCalledWith(PHONE, "dark");
    expect(hub.hub.hold).toHaveBeenCalledTimes(runs.length + 2 + 4);
  });

  it("returns screenshots in points with how to use them", async () => {
    const { controller } = setup();
    const result = await controller.invoke(request("screenshot", { device_id: PHONE }));
    expect(result.content).toEqual([
      { type: "image", data: Buffer.from("png-bytes").toString("base64"), mimeType: "image/png" },
      {
        type: "text",
        text: "Screenshot of iPhone 17, 402×874 points. Use these points with tap, swipe and pinch.",
      },
    ]);
  });

  it("writes its own text for refusals and failures", async () => {
    const { controller, hub } = setup({
      answer: (command) =>
        command.name === "press"
          ? { ok: false, code: "COMMAND_FAILED", reason: "ref_frame_expired", message: "/private/x" }
          : OK,
    });
    expect(text(await controller.invoke(request("tap", { device_id: PHONE, ref: "@e9" })))).toBe(
      "That ref is from an older screen. Take a new snapshot and use its refs.",
    );
    expect(text(await controller.invoke(request("tap", { device_id: SPARE, x: 1, y: 1 })))).toBe(
      "iPhone 16e isn't running. Start it with boot_device.",
    );
    hub.find(SPARE)!.state = "booting";
    expect(text(await controller.invoke(request("tap", { device_id: SPARE, x: 1, y: 1 })))).toBe(
      "iPhone 16e is still starting. Try again in a moment.",
    );
    hub.find(SPARE)!.state = "shutting-down";
    expect(text(await controller.invoke(request("boot_device", { device_id: SPARE })))).toBe(
      "iPhone 16e is shutting down. Try again when it has stopped.",
    );
    const missing = "22222222-2222-4222-8222-222222222222";
    expect(text(await controller.invoke(request("snapshot", { device_id: missing })))).toBe(
      `No simulator has ID ${missing}. Call list_devices.`,
    );
    expect(hub.hub.refresh).toHaveBeenCalled();
    hub.hub.rotate.mockRejectedValueOnce(new DeviceActionError("iPhone 17 can't turn upside down."));
    expect(
      text(await controller.invoke(request("rotate", { device_id: PHONE, orientation: "portrait-upside-down" }))),
    ).toBe("iPhone 17 can't turn upside down.");
    hub.hub.input.mockRejectedValueOnce(new Error("That didn't reach iPhone 17."));
    expect(text(await controller.invoke(request("press_key", { device_id: PHONE, key: "tab" })))).toBe(
      "That didn't reach iPhone 17.",
    );
  });

  it("checks an app bundle before installing it", async () => {
    const inspectAppBundle = vi.fn(async () => "That .app is built for iPhones, not the iOS Simulator.");
    const { controller, runs } = setup({ inspectAppBundle });
    expect(text(await controller.invoke(request("install_app", { device_id: PHONE, path: APP })))).toBe(
      "That .app is built for iPhones, not the iOS Simulator.",
    );
    expect(runs).toHaveLength(0);
  });

  it("shows agent touches on the portrait screen when the user wants them", async () => {
    const { controller, hub, automation, touches } = setup({
      answer: (command) =>
        command.name === "press" && command.operands?.[0] === "@e3"
          ? { ok: true, data: { x: 201, y: 319, referenceWidth: 402, referenceHeight: 874 } }
          : OK,
    });
    await controller.invoke(request("tap", { device_id: PHONE, x: 10, y: 20 }));
    await controller.invoke(request("tap", { device_id: PHONE, ref: "@e3" }));
    await controller.invoke(request("tap", { device_id: PHONE, x: 10, y: 20, count: 2 }));
    await controller.invoke(request("tap", { device_id: PHONE, x: 10, y: 20, hold_ms: 500 }));
    await controller.invoke(
      request("swipe", { device_id: PHONE, from_x: 10, from_y: 20, to_x: 30, to_y: 40 }),
    );
    await controller.invoke(request("pinch", { device_id: PHONE, scale: 2, x: 50, y: 60 }));
    expect(touches).toEqual([
      { deviceId: PHONE, kind: "tap", at: { x: 10, y: 20 } },
      { deviceId: PHONE, kind: "tap", at: { x: 201, y: 319 } },
      { deviceId: PHONE, kind: "double-tap", at: { x: 10, y: 20 } },
      { deviceId: PHONE, kind: "long-press", at: { x: 10, y: 20 } },
      { deviceId: PHONE, kind: "swipe", at: { x: 10, y: 20 }, to: { x: 30, y: 40 } },
      { deviceId: PHONE, kind: "pinch", at: { x: 50, y: 60 }, scale: 2 },
    ]);

    touches.splice(0);
    await controller.invoke(request("rotate", { device_id: PHONE, orientation: "landscape-left" }));
    // Until a screenshot shows whether the app turned, a point can't be placed.
    await controller.invoke(request("tap", { device_id: PHONE, x: 100, y: 50 }));
    expect(touches).toEqual([]);
    automation.screenshot.mockResolvedValueOnce({
      ok: true,
      png: Buffer.from("png"),
      data: { width: 874, height: 402, displayRotation: "landscape-left" },
    });
    await controller.invoke(request("screenshot", { device_id: PHONE }));
    await controller.invoke(request("tap", { device_id: PHONE, x: 100, y: 50 }));
    expect(touches).toEqual([{ deviceId: PHONE, kind: "tap", at: { x: 352, y: 100 } }]);

    touches.splice(0);
    hub.preferences.showAgentTouches = false;
    await controller.invoke(request("tap", { device_id: PHONE, x: 100, y: 50 }));
    expect(touches).toEqual([]);
  });

  it("tells recordings what the agent did once it worked, in the agent's points", async () => {
    const { controller, actions } = setup({
      answer: (command) => {
        if (command.name === "press" && command.operands?.[0] === "@e3") {
          return { ok: true, data: { x: 201, y: 319, referenceWidth: 402, referenceHeight: 874 } };
        }
        if (command.name === "install") {
          return { ok: true, data: { appName: "My App", bundleId: "com.example.my-app" } };
        }
        if (command.name === "scroll") return { ok: true, data: { movement: "moved" } };
        if (command.name === "swipe") return failureReply("COMMAND_FAILED", "No swipe");
        return OK;
      },
    });
    const call = (tool: DeviceToolInvokeRequest["tool"], args: Record<string, unknown>) =>
      controller.invoke(request(tool, { device_id: PHONE, ...args }));
    await call("tap", { x: 10, y: 20 });
    await call("tap", { ref: "@e3", count: 2 });
    await call("tap", { ref: "@e4", hold_ms: 500 });
    await call("type_text", { text: "hello" });
    await call("type_text", { text: "", ref: "@e5" });
    await call("swipe", { from_x: 10, from_y: 20, to_x: 30, to_y: 40 });
    await call("swipe", { from_x: 100, from_y: 500, to_x: 100, to_y: 200, duration_ms: 600 });
    await call("scroll", { direction: "down" });
    await call("pinch", { scale: 0.5 });
    await call("open_url", { url: "https://example.com/a" });
    await call("launch_app", { bundle_id: "com.example.my-app" });
    await call("install_app", { path: APP });
    await call("press_key", { key: "enter" });
    await call("rotate", { orientation: "landscape-left" });
    await call("snapshot", {});
    await call("screenshot", {});
    await call("list_apps", {});
    expect(actions.map(([deviceId, agent]) => `${deviceId} ${agent}`)).toEqual(
      actions.map(() => `${PHONE} Codex`),
    );
    expect(actions.map(([, , action]) => action)).toEqual([
      { kind: "tap", at: { x: 10, y: 20 } },
      { kind: "double-tap", at: { x: 201, y: 319 }, target: "@e3" },
      { kind: "long-press", at: null, target: "@e4" },
      { kind: "text", text: "hello" },
      { kind: "swipe", from: { x: 100, y: 500 }, to: { x: 100, y: 200 } },
      { kind: "scroll", direction: "down" },
      { kind: "pinch", scale: 0.5 },
      { kind: "open", target: "https://example.com/a" },
      { kind: "open", target: "com.example.my-app" },
      { kind: "install", app: "My App (com.example.my-app)" },
      { kind: "key", key: "enter" },
      { kind: "rotate", orientation: "landscape-left" },
    ]);
  });

  it("is off when agents may not use simulators", async () => {
    const { controller, hub, confirm, runs } = setup();
    hub.preferences.agentsEnabled = false;
    for (const tool of ["list_devices", "tap"] as const) {
      expect(text(await controller.invoke(request(tool, { device_id: PHONE, x: 1, y: 1 })))).toBe(
        "Simulator use is turned off in Settings > Simulators.",
      );
    }
    expect(confirm).not.toHaveBeenCalled();
    expect(runs).toHaveLength(0);
  });

  it("refuses every call while simulators aren't available in this copy of Zeros", async () => {
    let available = false;
    const { controller, confirm, runs } = setup({ available: () => available });
    for (const tool of ["list_devices", "tap"] as const) {
      expect(text(await controller.invoke(request(tool, { device_id: PHONE, x: 1, y: 1 })))).toBe(
        "Simulators aren't available in this copy of Zeros.",
      );
    }
    expect(confirm).not.toHaveBeenCalled();
    expect(runs).toHaveLength(0);
    available = true;
    expect((await controller.invoke(request("list_devices", {}))).success).toBe(true);
  });

  it("still presses keys and buttons in a build without agent-device", async () => {
    const { controller, hub, confirm } = setup({ automation: false });
    expect(text(await controller.invoke(request("tap", { device_id: PHONE, x: 1, y: 1 })))).toBe(
      "This build of Zeros can't control simulators.",
    );
    expect(confirm).not.toHaveBeenCalled();
    expect((await controller.invoke(request("press_button", { device_id: PHONE, button: "lock" }))).success).toBe(
      true,
    );
    expect(hub.hub.input).toHaveBeenCalledWith(PHONE, { kind: "button", button: "lock" });
  });

  it("rejects malformed requests and arguments before anything else", async () => {
    const { controller, confirm, runs } = setup();
    for (const bad of [
      { ...request("tap", {}), version: 2 },
      { ...request("tap", {}), owner: { workspaceId: "../x", conversationId: "conv_a" } },
      { ...request("tap", {}), agent: "gemini" },
      { ...request("tap", {}), turnId: "" },
      { ...request("tap", {}), tool: "shell" },
    ]) {
      expect(text(await controller.invoke(bad as DeviceToolInvokeRequest))).toBe(
        "Invalid Zeros simulator tool request.",
      );
    }
    expect(text(await controller.invoke(request("tap", { device_id: PHONE })))).toBe(
      "Pass a ref from the latest snapshot, or x and y.",
    );
    expect(text(await controller.invoke(request("tap", { device_id: "--udid" , x: 1, y: 1 })))).toBe(
      "device_id must be a simulator ID from list_devices.",
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(runs).toHaveLength(0);
    expect(controller.release({ version: 1, owner: { workspaceId: "ws_1", conversationId: "conv_a" }, reason: "nope" } as never)).toBe(false);
  });

  it("frees a simulator that stops running", async () => {
    const { controller, hub } = setup();
    await controller.invoke(request("tap", { device_id: PHONE, x: 1, y: 1 }));
    expect(controller.state().holders).toHaveLength(1);
    hub.find(PHONE)!.state = "shutting-down";
    controller.syncDevices(hub.snapshot());
    expect(controller.state().holders).toEqual([]);
  });

  it("answers a cancelled call as cancelled and stops its action", async () => {
    const abort = new AbortController();
    const { controller, runs } = setup({
      answer: (_command, signal) =>
        new Promise((resolve) => {
          signal?.addEventListener("abort", () => resolve(failureReply("ABORTED")), { once: true });
          abort.abort();
        }),
    });
    const result = await controller.invoke(request("tap", { device_id: PHONE, x: 1, y: 1 }), abort.signal);
    expect(text(result)).toBe("The simulator action was cancelled.");
    expect(runs[0]?.signal?.aborted).toBe(true);
  });

  it("ends every use when Zeros quits", async () => {
    const { controller } = setup();
    await controller.invoke(request("tap", { device_id: PHONE, x: 1, y: 1 }));
    controller.dispose();
    expect(controller.state().holders).toEqual([]);
    expect(text(await controller.invoke(request("tap", { device_id: PHONE, x: 1, y: 1 })))).toBe(
      "Simulators are unavailable. Restart Zeros and try again.",
    );
  });
});

describe("gestures at a screenshot's points", () => {
  it("go straight to the device's own input while its screen is upright", async () => {
    const { controller, hub, runs, touches, actions, sleep } = setup();
    const call = async (tool: DeviceToolInvokeRequest["tool"], args: Record<string, unknown>) => {
      const result = await controller.invoke(request(tool, { device_id: PHONE, ...args }));
      expect(hub.holds()).toBe(0);
      return text(result);
    };
    await call("screenshot", {});
    expect(await call("tap", { x: 10, y: 20 })).toBe("Tapped 10, 20.");
    expect(await call("tap", { x: 10, y: 20, count: 2 })).toBe("Double-tapped 10, 20.");
    expect(sleep).toHaveBeenCalledWith(100);
    expect(await call("tap", { x: 10, y: 20, hold_ms: 800 })).toBe("Long-pressed 10, 20 for 800 ms.");
    expect(await call("swipe", { from_x: 10, from_y: 20, to_x: 30, to_y: 400 })).toBe(
      "Swiped from 10, 20 to 30, 400.",
    );
    await call("swipe", { from_x: 100, from_y: 500, to_x: 100, to_y: 200, duration_ms: 600 });
    expect(hub.hub.input.mock.calls).toEqual(
      [
        { kind: "tap", at: { x: 10, y: 20 } },
        { kind: "tap", at: { x: 10, y: 20 } },
        { kind: "tap", at: { x: 10, y: 20 } },
        { kind: "drag", from: { x: 10, y: 20 }, to: { x: 10, y: 20 }, durationMs: 800 },
        // agent-device's swipe is a fling of the same length.
        { kind: "drag", from: { x: 10, y: 20 }, to: { x: 30, y: 400 }, durationMs: 100 },
        { kind: "drag", from: { x: 100, y: 500 }, to: { x: 100, y: 200 }, durationMs: 600 },
      ].map((input) => [PHONE, input]),
    );
    expect(runs).toEqual([]);
    expect(touches).toEqual([
      { deviceId: PHONE, kind: "tap", at: { x: 10, y: 20 } },
      { deviceId: PHONE, kind: "double-tap", at: { x: 10, y: 20 } },
      { deviceId: PHONE, kind: "long-press", at: { x: 10, y: 20 } },
      { deviceId: PHONE, kind: "swipe", at: { x: 10, y: 20 }, to: { x: 30, y: 400 } },
      { deviceId: PHONE, kind: "swipe", at: { x: 100, y: 500 }, to: { x: 100, y: 200 } },
    ]);
    expect(actions.map(([, , action]) => action)).toEqual([
      { kind: "tap", at: { x: 10, y: 20 } },
      { kind: "double-tap", at: { x: 10, y: 20 } },
      { kind: "long-press", at: { x: 10, y: 20 } },
      { kind: "swipe", from: { x: 10, y: 20 }, to: { x: 30, y: 400 } },
      { kind: "swipe", from: { x: 100, y: 500 }, to: { x: 100, y: 200 } },
    ]);

    // Elements and two fingers are agent-device's.
    hub.hub.input.mockClear();
    await call("tap", { ref: "@e3" });
    await call("pinch", { scale: 2, x: 100, y: 200 });
    expect(runs.map((run) => run.command.name)).toEqual(["press", "gesture"]);
    expect(hub.hub.input).not.toHaveBeenCalled();
  });

  it("leave points agent-device must place to agent-device", async () => {
    const { controller, hub, automation, runs } = setup();
    const tap = async (x: number, y: number) => {
      const before = runs.length;
      await controller.invoke(request("tap", { device_id: PHONE, x, y }));
      return runs.length > before ? "agent-device" : "hub";
    };
    // Before any screenshot, what the points are on depends on the app.
    expect(await tap(10, 20)).toBe("agent-device");
    // A screenshot that isn't the screen's size.
    automation.screenshot.mockResolvedValueOnce({
      ok: true,
      png: Buffer.from("png"),
      data: { width: 320, height: 568, displayRotation: "portrait" },
    });
    await controller.invoke(request("screenshot", { device_id: PHONE }));
    expect(await tap(10, 21)).toBe("agent-device");
    await controller.invoke(request("screenshot", { device_id: PHONE }));
    expect(await tap(10, 22)).toBe("hub");
    // Off the screenshot.
    expect(await tap(403, 23)).toBe("agent-device");
    // Turned: only agent-device knows whether the app turned too.
    await controller.invoke(request("rotate", { device_id: PHONE, orientation: "landscape-left" }));
    expect(await tap(10, 24)).toBe("agent-device");
    automation.screenshot.mockResolvedValueOnce({
      ok: true,
      png: Buffer.from("png"),
      data: { width: 874, height: 402, displayRotation: "landscape-left" },
    });
    await controller.invoke(request("screenshot", { device_id: PHONE }));
    expect(await tap(10, 25)).toBe("agent-device");
    // Upright again, but the latest screenshot is turned.
    await controller.invoke(request("rotate", { device_id: PHONE, orientation: "portrait" }));
    expect(await tap(10, 26)).toBe("agent-device");
    await controller.invoke(request("screenshot", { device_id: PHONE }));
    expect(await tap(10, 27)).toBe("hub");
    // A device DeviceHub can't drive, such as an emulator started elsewhere.
    hub.hub.canDrive.mockReturnValue(false);
    expect(await tap(10, 28)).toBe("agent-device");
    expect(hub.hub.input.mock.calls.filter(([, input]) => input.kind === "tap")).toEqual([
      [PHONE, { kind: "tap", at: { x: 10, y: 22 } }],
      [PHONE, { kind: "tap", at: { x: 10, y: 27 } }],
    ]);
  });

  it("stop between the taps of a double tap when the chat stops", async () => {
    const { controller, hub, sleep } = setup();
    await controller.invoke(request("screenshot", { device_id: PHONE }));
    sleep.mockImplementationOnce(async () => {
      controller.stopFromUser(PHONE);
    });
    const result = await controller.invoke(request("tap", { device_id: PHONE, x: 10, y: 20, count: 2 }));
    expect(text(result)).toBe("The user stopped you on iPhone 17. Don't use it again until the user asks.");
    expect(hub.hub.input).toHaveBeenCalledTimes(1);
  });

  it("come with screenshots Zeros takes of the upright screen itself", async () => {
    const { controller, hub, automation, runs, screen } = setup({ ownScreen: true });
    const result = await controller.invoke(request("screenshot", { device_id: PHONE }));
    expect(result.content).toEqual([
      { type: "image", data: Buffer.from("own-png").toString("base64"), mimeType: "image/png" },
      {
        type: "text",
        text: "Screenshot of iPhone 17, 402×874 points. Use these points with tap, swipe and pinch.",
      },
    ]);
    expect(screen.port.image).toHaveBeenCalledWith(PHONE, { width: 402, height: 874 });
    expect(automation.screenshot).not.toHaveBeenCalled();
    expect(hub.holds()).toBe(0);
    await controller.invoke(request("tap", { device_id: PHONE, x: 10, y: 20 }));
    expect(hub.hub.input).toHaveBeenCalledWith(PHONE, { kind: "tap", at: { x: 10, y: 20 } });
    expect(runs).toEqual([]);
  });

  it("leave screenshots Zeros can't take as the device shows them to agent-device", async () => {
    const { controller, hub, automation, screen } = setup({ ownScreen: true });
    const image = screen.port.image;
    image.mockResolvedValue(null);
    const shoot = async () => {
      const before = automation.screenshot.mock.calls.length;
      await controller.invoke(request("screenshot", { device_id: PHONE }));
      return automation.screenshot.mock.calls.length > before ? "agent-device" : "zeros";
    };
    // The screen came out turned, as an app can turn it.
    expect(await shoot()).toBe("agent-device");
    image.mockRejectedValueOnce(new Error("simctl failed"));
    expect(await shoot()).toBe("agent-device");
    image.mockResolvedValue(Buffer.from("own"));
    expect(await shoot()).toBe("zeros");
    const asked = image.mock.calls.length;
    await controller.invoke(request("rotate", { device_id: PHONE, orientation: "landscape-left" }));
    expect(await shoot()).toBe("agent-device");
    await controller.invoke(request("rotate", { device_id: PHONE, orientation: "portrait" }));
    hub.hub.canDrive.mockReturnValueOnce(false);
    expect(await shoot()).toBe("agent-device");
    hub.hub.deviceScreen.mockResolvedValueOnce(null);
    expect(await shoot()).toBe("agent-device");
    expect(image.mock.calls.length).toBe(asked);
  });

  it("space separate gestures so two taps never make a double tap", async () => {
    const { controller, hub, sleep, time, advance } = setup();
    const sent: Array<[string, number]> = [];
    hub.hub.input.mockImplementation(async (_id, input) => {
      sent.push([input.kind, time()]);
    });
    const call = async (tool: DeviceToolInvokeRequest["tool"], args: Record<string, unknown>) =>
      text(await controller.invoke(request(tool, { device_id: PHONE, ...args })));
    await call("screenshot", {});
    const start = time();
    await call("tap", { x: 10, y: 20 });
    await call("tap", { x: 10, y: 20 });
    await call("swipe", { from_x: 10, from_y: 20, to_x: 30, to_y: 400 });
    // After agent-device's own tap too.
    await call("tap", { ref: "@e3" });
    await call("tap", { x: 10, y: 20, count: 2 });
    expect(sent).toEqual([
      ["tap", start],
      ["tap", start + 400],
      ["drag", start + 800],
      ["tap", start + 1_200],
      ["tap", start + 1_300],
    ]);
    // An agent's own pace needs no gap.
    advance(2_000);
    sleep.mockClear();
    await call("tap", { x: 10, y: 20 });
    expect(sleep).not.toHaveBeenCalled();

    // The gap ends with the chat.
    sleep.mockImplementationOnce(async () => {
      controller.stopFromUser(PHONE);
    });
    hub.hub.input.mockClear();
    expect(await call("tap", { x: 10, y: 20 })).toBe(
      "The user stopped you on iPhone 17. Don't use it again until the user asks.",
    );
    expect(hub.hub.input).not.toHaveBeenCalled();
  });

  it("drive Android in points, as its own input takes them", async () => {
    const { controller, hub, automation, runs } = setup({ android: true });
    automation.screenshot.mockResolvedValueOnce({
      ok: true,
      png: Buffer.from("png"),
      data: { width: 411, height: 923, displayRotation: "portrait" },
    });
    await controller.invoke(request("screenshot", { device_id: PIXEL }));
    await controller.invoke(request("tap", { device_id: PIXEL, x: 100, y: 200 }));
    await controller.invoke(
      request("swipe", { device_id: PIXEL, from_x: 100, from_y: 600, to_x: 100, to_y: 200 }),
    );
    expect(hub.hub.input.mock.calls).toEqual([
      [PIXEL, { kind: "tap", at: { x: 100, y: 200 } }],
      [PIXEL, { kind: "drag", from: { x: 100, y: 600 }, to: { x: 100, y: 200 }, durationMs: 100 }],
    ]);
    expect(runs).toEqual([]);
  });

  it("drive Android from screenshots Zeros takes in points", async () => {
    const { controller, hub, automation, runs, screen } = setup({ android: true, ownScreen: true });
    expect(text(await controller.invoke(request("screenshot", { device_id: PIXEL })))).toBe(
      "Screenshot of Pixel 9, 411×923 points. Use these points with tap, swipe and pinch.",
    );
    expect(screen.port.image).toHaveBeenCalledWith(PIXEL, { width: 411, height: 923 });
    expect(automation.screenshot).not.toHaveBeenCalled();
    await controller.invoke(request("tap", { device_id: PIXEL, x: 100, y: 200 }));
    expect(hub.hub.input.mock.calls).toEqual([[PIXEL, { kind: "tap", at: { x: 100, y: 200 } }]]);
    expect(runs).toEqual([]);
  });
});

describe("screenshots Zeros takes after an action", () => {
  async function afterTap(still: (sinceTap: number) => number | null) {
    const used = setup({ ownScreen: true });
    await used.controller.invoke(request("screenshot", { device_id: PHONE }));
    await used.controller.invoke(request("tap", { device_id: PHONE, x: 10, y: 20 }));
    const tapped = used.time();
    used.screen.stillFor((now) => still(now - tapped));
    await used.controller.invoke(request("screenshot", { device_id: PHONE }));
    return { ...used, tapped, waited: used.screen.reads[1]! - tapped };
  }

  it("wait until the live view shows the screen still", async () => {
    // What the tap set off moves the screen for 400 ms.
    const { waited, screen } = await afterTap((sinceTap) => Math.max(0, sinceTap - 400));
    expect(waited).toBeGreaterThanOrEqual(400 + 250);
    expect(waited).toBeLessThanOrEqual(400 + 250 + 50);
    // Nothing happened since the first screenshot.
    expect(screen.reads[0]).toBe(10_000);
  });

  it("give the app a moment to answer a screen that hasn't moved yet", async () => {
    const { waited } = await afterTap((sinceTap) => 5_000 + sinceTap);
    expect(waited).toBe(250);
  });

  it("stop waiting on a screen that keeps moving", async () => {
    const { waited } = await afterTap(() => 0);
    expect(waited).toBe(2_000);
  });

  it("give iOS buttons time to rule out a double press", async () => {
    const waits: Record<string, number> = {};
    for (const [label, android, still] of [
      ["ios", false, (since: number) => 5_000 + since],
      ["ios-blind", false, () => null],
      ["android", true, (since: number) => 5_000 + since],
      ["android-blind", true, () => null],
    ] as const) {
      const { controller, screen, time } = setup({ android, ownScreen: true });
      const id = android ? PIXEL : PHONE;
      await controller.invoke(request("press_button", { device_id: id, button: "home" }));
      const pressed = time();
      screen.stillFor((now) => still(now - pressed));
      await controller.invoke(request("screenshot", { device_id: id }));
      waits[label] = screen.reads[0]! - pressed;
    }
    expect(waits).toEqual({ ios: 700, "ios-blind": 1_050, android: 250, "android-blind": 600 });
  });

  it("wait a set time when no live view shows the screen", async () => {
    const { waited } = await afterTap(() => null);
    expect(waited).toBe(600);
  });

  it("don't wait long after the action, or after only reading the screen", async () => {
    const { controller, screen, sleep, advance } = setup({ ownScreen: true });
    screen.stillFor(() => 0);
    await controller.invoke(request("tap", { device_id: PHONE, ref: "@e3" }));
    advance(2_000);
    await controller.invoke(request("screenshot", { device_id: PHONE }));
    await controller.invoke(request("snapshot", { device_id: PHONE }));
    await controller.invoke(request("screenshot", { device_id: PHONE }));
    expect(sleep).not.toHaveBeenCalled();
    expect(screen.reads).toHaveLength(2);
  });

  it("wait after any action that changes the screen", async () => {
    const { controller, screen, time } = setup({ ownScreen: true });
    screen.stillFor(() => null);
    const waits: number[] = [];
    const shootAfter = async (tool: DeviceToolInvokeRequest["tool"], args: Record<string, unknown>) => {
      await controller.invoke(request(tool, { device_id: PHONE, ...args }));
      const acted = time();
      await controller.invoke(request("screenshot", { device_id: PHONE }));
      waits.push(screen.reads.at(-1)! - acted);
    };
    await shootAfter("press_key", { key: "enter" });
    await shootAfter("launch_app", { bundle_id: "com.apple.Preferences" });
    await shootAfter("type_text", { text: "hello" });
    expect(waits).toEqual([600, 600, 600]);
  });

  it("end the wait when the chat stops", async () => {
    const used = setup({ ownScreen: true });
    await used.controller.invoke(request("tap", { device_id: PHONE, ref: "@e3" }));
    used.sleep.mockImplementationOnce(async () => {
      used.controller.stopFromUser(PHONE);
    });
    const result = await used.controller.invoke(request("screenshot", { device_id: PHONE }));
    expect(text(result)).toBe("The user stopped you on iPhone 17. Don't use it again until the user asks.");
    expect(used.screen.port.image).not.toHaveBeenCalled();
    expect(used.automation.screenshot).not.toHaveBeenCalled();
  });
});

describe("Android simulators for agents", () => {
  it("lists them with the iOS simulators", async () => {
    const { controller } = setup({ android: true });
    expect(text(await controller.invoke(request("list_devices", {})))).toContain(
      `- Pixel 9 (Android 17), running, ID ${PIXEL}`,
    );
  });

  it("takes the agent's points, gives agent-device pixels and scales screenshots to points", async () => {
    const { controller, hub, automation, runs, touches, actions } = setup({
      android: true,
      answer: (command) => {
        if (command.name === "press" && command.operands?.[0] === "@e3") {
          return { ok: true, data: { x: 540, y: 179, referenceWidth: 1080, referenceHeight: 2337 } };
        }
        if (command.name === "gesture" && command.operands?.length === 2) {
          return { ok: true, data: { from: { x: 540, y: 1212 }, to: { x: 540, y: 1212 } } };
        }
        return OK;
      },
    });
    // An emulator started outside Zeros, which only agent-device drives.
    hub.hub.canDrive.mockReturnValue(false);
    automation.screenshot.mockResolvedValueOnce({
      ok: true,
      png: Buffer.from("png"),
      data: { width: 411, height: 923, displayRotation: "portrait" },
    });
    const call = async (tool: DeviceToolInvokeRequest["tool"], args: Record<string, unknown>) =>
      text(await controller.invoke(request(tool, { device_id: PIXEL, ...args })));
    expect(await call("screenshot", {})).toBe(
      "Screenshot of Pixel 9, 411×923 points. Use these points with tap, swipe and pinch.",
    );
    expect(automation.screenshot).toHaveBeenCalledWith(PIXEL, expect.any(AbortSignal), {
      scale: 1 / 2.625,
    });
    expect(await call("tap", { x: 100, y: 200 })).toBe("Tapped 100, 200.");
    expect(await call("tap", { ref: "@e3" })).toBe("Tapped @e3.");
    await call("tap", { x: 100, y: 200, count: 2 });
    await call("tap", { x: 100, y: 200, hold_ms: 800 });
    expect(await call("swipe", { from_x: 100, from_y: 200, to_x: 100, to_y: 600 })).toBe(
      "Swiped from 100, 200 to 100, 600.",
    );
    await call("swipe", { from_x: 100, from_y: 600, to_x: 100, to_y: 200, duration_ms: 600 });
    await call("pinch", { scale: 2, x: 200, y: 400 });
    await call("pinch", { scale: 0.5 });
    expect(runs.map((run) => run.command.operands)).toEqual([
      ["263", "525"],
      ["@e3"],
      ["263", "525"],
      ["263", "525", "800"],
      ["263", "525", "263", "1575"],
      ["pan", "263", "1575", "0", "-1050", "600"],
      ["pinch", "2", "525", "1050"],
      ["pinch", "0.5"],
    ]);
    expect(touches.map(({ kind, at, to }) => ({ kind, at, ...(to ? { to } : {}) }))).toEqual([
      { kind: "tap", at: { x: 100, y: 200 } },
      { kind: "tap", at: { x: 206, y: 68 } },
      { kind: "double-tap", at: { x: 100, y: 200 } },
      { kind: "long-press", at: { x: 100, y: 200 } },
      { kind: "swipe", at: { x: 100, y: 200 }, to: { x: 100, y: 600 } },
      { kind: "swipe", at: { x: 100, y: 600 }, to: { x: 100, y: 200 } },
      { kind: "pinch", at: { x: 200, y: 400 } },
      { kind: "pinch", at: { x: 206, y: 462 } },
    ]);
    expect(actions[1]?.[2]).toEqual({ kind: "tap", at: { x: 206, y: 68 }, target: "@e3" });
  });

  it("answers in points only once it knows the screen's size", async () => {
    const { controller, hub, runs } = setup({ android: true });
    hub.hub.deviceScreen.mockResolvedValue(null);
    expect(text(await controller.invoke(request("tap", { device_id: PIXEL, x: 10, y: 20 })))).toBe(
      "Zeros couldn't read Pixel 9's screen size. Try again.",
    );
    expect(text(await controller.invoke(request("tap", { device_id: PIXEL, ref: "@e2" })))).toBe(
      "Tapped @e2.",
    );
    expect(runs.map((run) => run.command.operands)).toEqual([["@e2"]]);
  });

  it("presses Back on Android, and tells agents iOS has none", async () => {
    const { controller, hub } = setup({ android: true });
    expect(text(await controller.invoke(request("press_button", { device_id: PIXEL, button: "back" })))).toBe(
      "Pressed Back.",
    );
    expect(hub.hub.input).toHaveBeenCalledWith(PIXEL, { kind: "button", button: "back" });
    hub.hub.input.mockClear();
    expect(text(await controller.invoke(request("press_button", { device_id: PHONE, button: "back" })))).toBe(
      "iOS simulators have no Back button. Tap the app's own back control, or swipe right from the screen's left edge.",
    );
    expect(hub.hub.input).not.toHaveBeenCalled();
  });

  it("installs .apk files on Android and .app bundles on iOS", async () => {
    const inspectAppBundle = vi.fn(async () => null);
    const { controller, runs } = setup({
      android: true,
      inspectAppBundle,
      answer: (command) =>
        command.name === "install"
          ? { ok: true, data: { app: "com.example.app", appId: "com.example.app", package: "com.example.app" } }
          : OK,
    });
    expect(text(await controller.invoke(request("install_app", { device_id: PIXEL, path: APK })))).toBe(
      "Installed com.example.app on Pixel 9. Open it with launch_app.",
    );
    expect(runs.map((run) => run.command)).toEqual([{ name: "install", operands: [APK] }]);
    expect(inspectAppBundle).not.toHaveBeenCalled();
    expect(text(await controller.invoke(request("install_app", { device_id: PIXEL, path: APP })))).toBe(
      "Android simulators install .apk files, not .app bundles.",
    );
    expect(text(await controller.invoke(request("install_app", { device_id: PHONE, path: APK })))).toBe(
      "iOS simulators install .app bundles built for the iOS Simulator, not .apk files.",
    );
    expect(runs).toHaveLength(1);
  });

  it("says when no app opens a link", async () => {
    const { controller, automation } = setup({ android: true });
    automation.openTarget.mockResolvedValue(failureReply("COMMAND_FAILED", "adb exited with code 1"));
    expect(
      text(await controller.invoke(request("open_url", { device_id: PIXEL, url: "myapp://settings" }))),
    ).toBe("No app on Pixel 9 opens myapp: links.");
    expect(
      text(await controller.invoke(request("open_url", { device_id: PIXEL, url: "https://example.com" }))),
    ).toBe("adb exited with code 1");
  });
});

describe("turning simulators through agent-device", () => {
  it("follows the app in front and words failures for people", async () => {
    const run = vi.fn(async (): Promise<AgentDeviceReply> => OK);
    const port = agentDeviceOrientation({ run });
    await port.set(PHONE, "landscape-right", "iPhone 17");
    expect(run).toHaveBeenCalledWith(PHONE, {
      name: "orientation",
      operands: ["landscape-right"],
      followFront: true,
    });
    run.mockResolvedValueOnce(
      failureReply("COMMAND_FAILED", "device orientation is portrait, expected portrait-upside-down"),
    );
    await expect(port.set(PHONE, "portrait-upside-down", "iPhone 17")).rejects.toThrow(
      new DeviceActionError("iPhone 17 can't turn upside down."),
    );
    run.mockResolvedValueOnce(failureReply("TIMEOUT"));
    await expect(port.set(PHONE, "landscape-left", "iPhone 17")).rejects.toThrow(
      "iPhone 17 didn't respond in time. Try again.",
    );
  });
});

describe("pinching simulators through agent-device", () => {
  it("pinches around the screen's center in the app in front", async () => {
    const run = vi.fn(async (): Promise<AgentDeviceReply> => OK);
    const port = agentDevicePinch({ run });
    await port.pinch(PHONE, 0.5, "iPhone 17");
    expect(run).toHaveBeenCalledWith(PHONE, {
      name: "gesture",
      operands: ["pinch", "0.5"],
      followFront: true,
    });
    run.mockResolvedValueOnce(failureReply("TIMEOUT"));
    await expect(port.pinch(PHONE, 2, "iPhone 17")).rejects.toThrow(
      new DeviceActionError("iPhone 17 didn't respond in time. Try again."),
    );
  });
});
