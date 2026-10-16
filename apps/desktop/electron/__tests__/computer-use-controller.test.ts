import { afterEach, describe, expect, it, vi } from "vitest";

import {
  computerUseWaitText,
  type ComputerToolInvokeRequest,
  type ComputerToolResult,
} from "@zeros/protocol/computer-use-tools";

import {
  ComputerUseController,
  computerDriverArguments,
} from "../computer-use/controller";
import {
  ComputerDriverLostError,
  type ComputerControlPanel,
  type ComputerDriverResult,
  type ComputerDriverSession,
  type ComputerDriverTool,
} from "../computer-use/ports";

const SELF_PID = 4_242;

const APPS = [
  { name: "Safari", bundle_id: "com.apple.Safari", pid: 501, running: true },
  { name: "TextEdit", bundle_id: "com.apple.TextEdit", pid: 502, running: true },
  {
    name: "Keychain Access",
    bundle_id: "com.apple.keychainaccess",
    pid: 503,
    running: true,
  },
  { name: "Zeros", bundle_id: "com.zeros", pid: SELF_PID, running: true },
  { name: "Zeros Beta", bundle_id: "com.zeros.beta", pid: 505, running: true },
  { name: "Notes", bundle_id: "com.apple.Notes", pid: 0, running: false },
];

const WINDOWS = [
  { window_id: 11, pid: 501, app_name: "Safari", title: "Apple", bounds: { x: 0, y: 0, width: 800, height: 600 } },
  { window_id: 12, pid: 502, app_name: "TextEdit", title: "Untitled", bounds: { x: 10, y: 10, width: 400, height: 300 } },
  { window_id: 13, pid: 503, app_name: "Keychain Access", title: "Passwords", bounds: null },
  { window_id: 14, pid: SELF_PID, app_name: "Zeros", title: "Zeros", bounds: null },
  { window_id: 15, pid: 9_999, app_name: "cua-driver", title: "", bounds: null },
];

function ok(text = "", structured: Record<string, unknown> | null = null): ComputerDriverResult {
  return { isError: false, errorCode: null, text, structured, images: [] };
}

interface FakeCall {
  tool: ComputerDriverTool;
  args: Record<string, unknown>;
}

class FakeSession implements ComputerDriverSession {
  readonly calls: FakeCall[] = [];
  closed = false;
  constructor(
    readonly label: string,
    private readonly handle: (
      call: FakeCall,
      signal: AbortSignal,
    ) => Promise<ComputerDriverResult> | undefined,
  ) {}

  async call(
    tool: ComputerDriverTool,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<ComputerDriverResult> {
    if (this.closed) throw new Error("session closed");
    const call = { tool, args };
    this.calls.push(call);
    const custom = this.handle(call, signal);
    if (custom) return custom;
    switch (tool) {
      case "list_apps":
        return ok("apps", { apps: APPS });
      case "list_windows": {
        const pid = args.pid;
        return ok("windows", {
          windows: WINDOWS.filter((window) => pid === undefined || window.pid === pid),
        });
      }
      case "get_window_state":
        return {
          ...ok("tree", {
            window_id: args.window_id,
            window_title: "Untitled",
            screenshot_width: 800,
            screenshot_height: 600,
            elements: [
              { element_token: "sdeadbeef:0", role: "AXWindow", label: "Untitled", depth: 0 },
              { element_token: "sdeadbeef:1", role: "AXTextArea", value: "Hello", depth: 1 },
            ],
          }),
          images: [
            { data: "iVBORw0KGgo=", mimeType: "image/png" },
            { data: "R0lGOD", mimeType: "image/gif" },
          ],
        };
      default:
        return ok(`${tool} done via get_window_state`);
    }
  }

  close(): void {
    this.closed = true;
  }

  actions(): FakeCall[] {
    return this.calls.filter(
      (call) =>
        call.tool !== "list_apps" &&
        call.tool !== "list_windows" &&
        !call.tool.startsWith("set_agent_cursor"),
    );
  }
}

function setup(
  options: {
    handle?: (call: FakeCall, signal: AbortSignal) => Promise<ComputerDriverResult> | undefined;
    decision?: "allow" | "deny";
    enabled?: boolean;
    showAgentCursor?: boolean;
  } = {},
) {
  const sessions: FakeSession[] = [];
  const host = {
    openSession: vi.fn(async (label: string) => {
      const session = new FakeSession(label, options.handle ?? (() => undefined));
      sessions.push(session);
      return session;
    }),
    stop: vi.fn(async () => undefined),
  };
  const permissions = { accessibility: true, screenRecording: true };
  const panel = {
    show: vi.fn(),
    hide: vi.fn(),
    withoutEscape: vi.fn(<T>(work: () => Promise<T>) => work()),
  };
  const confirm = vi.fn(
    async (_input: unknown, _signal: AbortSignal) => options.decision ?? "allow",
  );
  const denyConfirmations = vi.fn();
  const states: unknown[] = [];
  const controller = new ComputerUseController({
    host,
    permissions: { status: () => ({ ...permissions }) },
    panel: panel as ComputerControlPanel,
    confirm: confirm as never,
    denyConfirmations,
    onState: (state) => states.push(state),
    selfPid: SELF_PID,
    idleStopMs: 10_000,
    waitTimeoutMs: 60_000,
    actionTimeoutMs: 5_000,
    nativeActivityTtlMs: 30_000,
  });
  if (options.enabled !== false) {
    controller.setPreferences({
      enabled: true,
      showAgentCursor: options.showAgentCursor ?? true,
      blockedApps: ["com.apple.keychainaccess"],
    });
  }
  return { controller, host, sessions, permissions, panel, confirm, denyConfirmations, states };
}

function request(
  tool: ComputerToolInvokeRequest["tool"],
  args: Record<string, unknown>,
  overrides: Partial<ComputerToolInvokeRequest> & { conversationId?: string } = {},
): ComputerToolInvokeRequest {
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

function text(result: ComputerToolResult): string {
  return result.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

async function settle(): Promise<void> {
  for (let index = 0; index < 50; index += 1) await Promise.resolve();
}

describe("Zeros computer use controller", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays off until Settings turns it on and macOS grants access", async () => {
    const off = setup({ enabled: false });
    const result = await off.controller.invoke(
      request("click", { pid: 501, element_token: "sdeadbeef:1" }),
    );
    expect(result.success).toBe(false);
    expect(text(result)).toMatch(/turned off in Settings > Computer use/);

    const ungranted = setup();
    ungranted.permissions.screenRecording = false;
    const missing = await ungranted.controller.invoke(request("list_apps", {}));
    expect(text(missing)).toBe(
      "Zeros needs Screen Recording access to use your Mac. The user can turn it on in Settings > Computer use.",
    );
    ungranted.permissions.accessibility = false;
    expect(
      text(await ungranted.controller.invoke(request("list_apps", {}))),
    ).toMatch(/Accessibility and Screen Recording access .* turn them on/);
    expect(off.host.openSession).not.toHaveBeenCalled();
    expect(ungranted.host.openSession).not.toHaveBeenCalled();
  });

  it("asks once per app in a chat, acts in that app and shows the control bar", async () => {
    const { controller, sessions, panel, confirm } = setup();
    const result = await controller.invoke(
      request("click", { pid: 501, element_token: "sdeadbeef:1" }),
    );
    expect(result.success).toBe(true);
    expect(text(result)).toBe("click done via screenshot");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]![0]).toEqual({
      kind: "app",
      workspaceId: "ws_1",
      conversationId: "conv_a",
      agent: "codex",
      subject: "Safari",
      subjectId: "com.apple.Safari",
    });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.label).toBe("Codex");
    expect(sessions[0]!.actions()).toEqual([
      { tool: "click", args: { pid: 501, element_token: "sdeadbeef:1" } },
    ]);
    expect(panel.show).toHaveBeenLastCalledWith({
      title: "Codex",
      detail: "is using Safari",
    });
    expect(controller.state().holders).toEqual([
      {
        workspaceId: "ws_1",
        conversationId: "conv_a",
        agent: "codex",
        app: "Safari",
        native: false,
      },
    ]);

    await controller.invoke(request("type_text", { pid: 501, text: "hi" }));
    expect(confirm).toHaveBeenCalledTimes(1);

    expect(
      controller.release({
        version: 1,
        owner: { workspaceId: "ws_1", conversationId: "conv_a" },
        reason: "turn-end",
      }),
    ).toBe(true);
    expect(sessions[0]!.closed).toBe(true);
    expect(panel.hide).toHaveBeenCalled();
    expect(controller.state().holders).toEqual([]);

    // Approvals last for the chat, across turns, until it retires.
    await controller.invoke(
      request("click", { pid: 501, element_token: "sdeadbeef:1" }, { turnId: "turn_2" }),
    );
    expect(confirm).toHaveBeenCalledTimes(1);
    controller.release({
      version: 1,
      owner: { workspaceId: "ws_1", conversationId: "conv_a" },
      reason: "retire",
    });
    await controller.invoke(
      request("click", { pid: 501, element_token: "sdeadbeef:1" }, { turnId: "turn_3" }),
    );
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("refuses Zeros and blocked apps before anything reaches the driver", async () => {
    const { controller, sessions, confirm } = setup();
    expect(
      text(
        await controller.invoke(
          request("click", { pid: 503, element_token: "sdeadbeef:1" }),
        ),
      ),
    ).toBe("Keychain Access is blocked in Settings > Computer use.");
    expect(
      text(await controller.invoke(request("type_text", { pid: SELF_PID, text: "x" }))),
    ).toBe("Agents cannot control Zeros.");
    expect(
      text(await controller.invoke(request("type_text", { pid: 505, text: "x" }))),
    ).toBe("Agents cannot control Zeros.");
    expect(
      text(await controller.invoke(request("type_text", { pid: 9_999, text: "x" }))),
    ).toBe("No app you can control has process ID 9999. Call list_apps.");
    expect(
      text(await controller.invoke(request("open_app", { bundle_id: "com.zeros.beta" }))),
    ).toBe("Agents cannot control Zeros.");
    expect(
      text(
        await controller.invoke(
          request("open_app", { bundle_id: "COM.APPLE.KEYCHAINACCESS" }),
        ),
      ),
    ).toBe("Keychain Access is blocked in Settings > Computer use.");

    const apps = text(await controller.invoke(request("list_apps", {})));
    expect(apps).toContain("Safari (pid 501) com.apple.Safari");
    expect(apps).toContain("Notes com.apple.Notes");
    expect(apps).not.toMatch(/Keychain|Zeros/);
    const running = text(
      await controller.invoke(request("list_apps", { running_only: true })),
    );
    expect(running).not.toContain("Notes");

    const windows = text(await controller.invoke(request("list_windows", {})));
    expect(windows).toContain("window 11: Safari (pid 501)");
    expect(windows).toContain("window 12: TextEdit (pid 502)");
    expect(windows).not.toMatch(/window 13|window 14|window 15/);

    expect(confirm).not.toHaveBeenCalled();
    expect(sessions[0]!.actions()).toEqual([]);
  });

  it("keeps window IDs to the approved app", async () => {
    const { controller, sessions } = setup();
    const result = await controller.invoke(
      request("click", { pid: 501, window_id: 12, x: 5, y: 5 }),
    );
    expect(text(result)).toBe(
      "Window 12 is not a window of Safari. Call list_windows.",
    );
    expect(sessions[0]!.actions()).toEqual([]);

    await controller.invoke(request("click", { pid: 501, window_id: 11, x: 5, y: 5 }));
    expect(sessions[0]!.actions()).toEqual([
      { tool: "click", args: { pid: 501, window_id: 11, x: 5, y: 5 } },
    ]);
  });

  it("ends the session when the user denies an app and does not ask again that turn", async () => {
    const { controller, sessions, confirm, panel } = setup({ decision: "deny" });
    const denied = await controller.invoke(
      request("click", { pid: 502, element_token: "sdeadbeef:1" }),
    );
    expect(denied.success).toBe(false);
    expect(text(denied)).toBe("The user did not allow Codex to control TextEdit.");
    expect(sessions[0]!.closed).toBe(true);
    expect(sessions[0]!.actions()).toEqual([]);
    expect(panel.show).not.toHaveBeenCalled();
    expect(controller.state().holders).toEqual([]);

    expect(
      text(
        await controller.invoke(
          request("click", { pid: 502, element_token: "sdeadbeef:1" }),
        ),
      ),
    ).toBe("The user did not allow Codex to control TextEdit.");
    expect(confirm).toHaveBeenCalledTimes(1);

    await controller.invoke(
      request("click", { pid: 502, element_token: "sdeadbeef:1" }, { turnId: "turn_2" }),
    );
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("lets one chat use the computer at a time and tells the others why they wait", async () => {
    const { controller, sessions } = setup();
    await controller.invoke(request("click", { pid: 501, element_token: "sdeadbeef:1" }));

    const waiting = controller.invoke(
      request(
        "type_text",
        { pid: 502, text: "from b" },
        { conversationId: "conv_b", agent: "claude" },
      ),
    );
    await settle();
    const state = controller.state();
    expect(state.waiting).toEqual([
      { workspaceId: "ws_1", conversationId: "conv_b", agent: "claude" },
    ]);
    expect(computerUseWaitText(state, "conv_b")).toBe(
      "Waiting for Codex in another chat to finish using the computer",
    );
    expect(sessions).toHaveLength(1);

    controller.release({
      version: 1,
      owner: { workspaceId: "ws_1", conversationId: "conv_a" },
      reason: "turn-end",
    });
    const result = await waiting;
    expect(result.success).toBe(true);
    expect(sessions).toHaveLength(2);
    expect(sessions[1]!.label).toBe("Claude Code");
    expect(controller.state()).toMatchObject({
      holders: [{ conversationId: "conv_b", app: "TextEdit" }],
      waiting: [],
    });
  });

  it("gives up waiting after the limit and leaves the line", async () => {
    vi.useFakeTimers();
    const { controller } = setup();
    await controller.invoke(request("click", { pid: 501, element_token: "sdeadbeef:1" }));
    const waiting = controller.invoke(
      request("list_apps", {}, { conversationId: "conv_b" }),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(text(await waiting)).toBe(
      "Another chat is still using the computer. Try again when it finishes.",
    );
    expect(controller.state().waiting).toEqual([]);
  });

  it("stops on the control bar's Stop or Esc and refuses the rest of that turn", async () => {
    let started!: () => void;
    const clickStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { controller, sessions, panel } = setup({
      handle: (call, signal) =>
        call.tool === "click"
          ? new Promise((_, reject) => {
              started();
              signal.addEventListener("abort", () => reject(signal.reason), {
                once: true,
              });
            })
          : undefined,
    });
    const pending = controller.invoke(
      request("click", { pid: 501, element_token: "sdeadbeef:1" }),
    );
    await clickStarted;
    expect(controller.stopFromUser()).toBe(true);
    const stopped = await pending;
    expect(text(stopped)).toBe(
      "The user stopped computer use. Do not use the computer again until the user asks.",
    );
    expect(sessions[0]!.closed).toBe(true);
    expect(panel.hide).toHaveBeenCalled();
    expect(controller.stopFromUser()).toBe(false);

    expect(text(await controller.invoke(request("list_apps", {})))).toMatch(
      /The user stopped computer use/,
    );
    const nextTurn = await controller.invoke(
      request("list_apps", {}, { turnId: "turn_2" }),
    );
    expect(nextTurn.success).toBe(true);
  });

  it("counts Codex's built-in computer use until its turn ends or goes quiet", async () => {
    vi.useFakeTimers();
    const { controller } = setup();
    const native = {
      version: 1 as const,
      owner: { workspaceId: "ws_1", conversationId: "conv_native" },
      agent: "codex" as const,
    };
    expect(controller.nativeActivity({ ...native, active: true })).toBe(true);
    expect(controller.state().holders).toEqual([
      {
        workspaceId: "ws_1",
        conversationId: "conv_native",
        agent: "codex",
        app: null,
        native: true,
      },
    ]);

    const waiting = controller.invoke(request("list_apps", {}));
    await vi.advanceTimersByTimeAsync(0);
    expect(computerUseWaitText(controller.state(), "conv_a")).toBe(
      "Waiting for Codex in another chat to finish using the computer",
    );
    controller.nativeActivity({ ...native, active: false });
    expect((await waiting).success).toBe(true);
    controller.release({
      version: 1,
      owner: { workspaceId: "ws_1", conversationId: "conv_a" },
      reason: "turn-end",
    });

    controller.nativeActivity({ ...native, active: true });
    const second = controller.invoke(
      request("list_apps", {}, { conversationId: "conv_b" }),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await second).success).toBe(true);
    expect(controller.state().holders.some((holder) => holder.native)).toBe(false);
  });

  it("renders a window screenshot with its element tokens and readable images", async () => {
    const { controller, sessions } = setup();
    const result = await controller.invoke(
      request("screenshot", { pid: 502, window_id: 12, elements: false }),
    );
    expect(result.success).toBe(true);
    expect(result.content[0]).toEqual({
      type: "image",
      data: "iVBORw0KGgo=",
      mimeType: "image/png",
    });
    expect(result.content).toHaveLength(2);
    expect(text(result)).toContain('TextEdit — "Untitled" (window 12)');
    expect(text(result)).toContain("Screenshot 800×600.");
    expect(text(result)).toContain('sdeadbeef:0 AXWindow "Untitled"');
    expect(text(result)).toContain('  sdeadbeef:1 AXTextArea value="Hello"');
    expect(sessions[0]!.actions()).toEqual([
      {
        tool: "get_window_state",
        args: { pid: 502, window_id: 12, include_accessibility_tree: false },
      },
    ]);
  });

  it("releases its Esc while the agent presses Escape", async () => {
    const { controller, panel } = setup();
    await controller.invoke(request("press_key", { pid: 502, key: "escape" }));
    expect(panel.withoutEscape).toHaveBeenCalledTimes(1);
    await controller.invoke(request("press_key", { pid: 502, key: "return" }));
    expect(panel.withoutEscape).toHaveBeenCalledTimes(1);
  });

  it("uses a quiet agent cursor, or hides it", async () => {
    const shown = setup();
    await shown.controller.invoke(request("list_apps", {}));
    expect(shown.sessions[0]!.calls.slice(0, 2)).toEqual([
      {
        tool: "set_agent_cursor_motion",
        args: {
          session: "Codex",
          style: "signature_arc",
          arc_size: 0,
          timing: "fitts",
          effects: {
            trail: false,
            glow: false,
            magnet: false,
            squish: false,
            ripple: true,
          },
          idle_hide_ms: 3_000,
        },
      },
      { tool: "set_agent_cursor_enabled", args: { session: "Codex", enabled: true } },
    ]);

    const hidden = setup({ showAgentCursor: false });
    await hidden.controller.invoke(request("list_apps", {}));
    expect(hidden.sessions[0]!.calls[0]).toEqual({
      tool: "set_agent_cursor_enabled",
      args: { session: "Codex", enabled: false },
    });
  });

  it("restarts a lost driver and stops it when idle", async () => {
    vi.useFakeTimers();
    let lose = true;
    const { controller, host, sessions } = setup({
      handle: (call) => {
        if (call.tool === "click" && lose) {
          lose = false;
          return Promise.reject(new ComputerDriverLostError());
        }
        return undefined;
      },
    });
    const lost = await controller.invoke(
      request("click", { pid: 501, element_token: "sdeadbeef:1" }),
    );
    expect(text(lost)).toBe("Computer use stopped unexpectedly. Try again.");
    expect(host.stop).toHaveBeenCalledTimes(1);
    expect(controller.state().holders).toEqual([]);

    const retried = await controller.invoke(
      request("click", { pid: 501, element_token: "sdeadbeef:1" }),
    );
    expect(retried.success).toBe(true);
    expect(sessions).toHaveLength(2);

    controller.release({
      version: 1,
      owner: { workspaceId: "ws_1", conversationId: "conv_a" },
      reason: "turn-end",
    });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(host.stop).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(host.stop).toHaveBeenCalledTimes(2);
  });

  it("reopens a session the driver expired without restarting it", async () => {
    let expire = true;
    const { controller, host, sessions } = setup({
      handle: (call) => {
        if (call.tool === "click" && expire) {
          expire = false;
          return Promise.resolve({
            ...ok("gone"),
            isError: true,
            errorCode: "session_unavailable",
          });
        }
        return undefined;
      },
    });
    const expired = await controller.invoke(
      request("click", { pid: 501, element_token: "sdeadbeef:1" }),
    );
    expect(text(expired)).toMatch(/session expired/);
    expect(host.stop).not.toHaveBeenCalled();
    expect(
      (
        await controller.invoke(
          request("click", { pid: 501, element_token: "sdeadbeef:1" }),
        )
      ).success,
    ).toBe(true);
    expect(sessions).toHaveLength(2);
  });

  it("restarts the driver after macOS access changes", async () => {
    const { controller, host, permissions } = setup();
    await controller.invoke(request("list_apps", {}));
    controller.release({
      version: 1,
      owner: { workspaceId: "ws_1", conversationId: "conv_a" },
      reason: "turn-end",
    });
    permissions.screenRecording = false;
    expect(controller.permissionStatus().screenRecording).toBe(false);
    permissions.screenRecording = true;
    await controller.invoke(request("list_apps", {}, { turnId: "turn_2" }));
    expect(host.stop).toHaveBeenCalledTimes(1);
    expect(host.openSession).toHaveBeenCalledTimes(2);
  });

  it("turns off at once when Settings disables computer use", async () => {
    const { controller, sessions, panel } = setup();
    await controller.invoke(request("click", { pid: 501, element_token: "sdeadbeef:1" }));
    const waiting = controller.invoke(
      request("list_apps", {}, { conversationId: "conv_b" }),
    );
    await settle();
    controller.setPreferences({
      enabled: false,
      showAgentCursor: true,
      blockedApps: [],
    });
    expect(sessions[0]!.closed).toBe(true);
    expect(panel.hide).toHaveBeenCalled();
    expect(text(await waiting)).toMatch(/turned off/);
    expect(controller.state()).toEqual({ version: 1, holders: [], waiting: [] });
  });

  it("ends a lease whose app becomes blocked", async () => {
    const { controller, sessions } = setup();
    await controller.invoke(request("click", { pid: 501, element_token: "sdeadbeef:1" }));
    controller.setPreferences({
      enabled: true,
      showAgentCursor: true,
      blockedApps: ["com.apple.Safari"],
    });
    expect(sessions[0]!.closed).toBe(true);
    expect(controller.state().holders).toEqual([]);
  });

  it("rejects malformed requests", async () => {
    const { controller } = setup();
    for (const bad of [
      { ...request("list_apps", {}), version: 2 },
      { ...request("list_apps", {}), agent: "droid" },
      { ...request("list_apps", {}), turnId: "" },
      { ...request("list_apps", {}), tool: "set_config" },
      { ...request("list_apps", {}), owner: { workspaceId: "ws 1", conversationId: "c" } },
    ]) {
      expect(text(await controller.invoke(bad as never))).toBe(
        "Invalid Zeros computer tool request.",
      );
    }
    expect(
      text(
        await controller.invoke(
          request("click", { pid: 501, element_token: "sdeadbeef:1", session: "x" }),
        ),
      ),
    ).toBe("Unknown argument: session.");
    expect(
      controller.release({
        version: 1,
        owner: { workspaceId: "ws_1", conversationId: "conv_a" },
        reason: "later" as never,
      }),
    ).toBe(false);
    expect(
      controller.nativeActivity({
        version: 1,
        owner: { workspaceId: "ws_1", conversationId: "conv_a" },
        agent: "codex",
        active: "yes" as never,
      }),
    ).toBe(false);
  });
});

describe("computer driver arguments", () => {
  it("adds foreground delivery only where macOS requires it", () => {
    expect(
      computerDriverArguments({
        tool: "click",
        pid: 1,
        windowId: 2,
        x: 3,
        y: 4,
        modifiers: ["cmd"],
        count: 2,
      }),
    ).toEqual({
      pid: 1,
      window_id: 2,
      x: 3,
      y: 4,
      count: 2,
      modifier: ["cmd"],
      delivery_mode: "foreground",
    });
    expect(
      computerDriverArguments({
        tool: "drag",
        pid: 1,
        windowId: 2,
        x: 3,
        y: 4,
        toX: 5,
        toY: 6,
      }),
    ).toEqual({
      pid: 1,
      window_id: 2,
      from_x: 3,
      from_y: 4,
      to_x: 5,
      to_y: 6,
      delivery_mode: "foreground",
    });
    expect(
      computerDriverArguments({
        tool: "press_key",
        pid: 1,
        key: "s",
        modifiers: ["cmd"],
      }),
    ).toEqual({ pid: 1, key: "s", modifiers: ["cmd"] });
    expect(
      computerDriverArguments({
        tool: "scroll",
        pid: 1,
        direction: "down",
        amount: 3,
        by: "page",
        elementToken: "sdeadbeef:2",
      }),
    ).toEqual({
      pid: 1,
      element_token: "sdeadbeef:2",
      direction: "down",
      amount: 3,
      by: "page",
    });
  });
});
