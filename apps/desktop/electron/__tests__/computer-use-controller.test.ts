import { afterEach, describe, expect, it, vi } from "vitest";

import {
  computerUseWaitText,
  type ComputerToolInvokeRequest,
  type ComputerToolResult,
} from "@zeros/protocol/computer-use-tools";

import {
  ComputerUseController,
  computerControlBar,
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
    enabled?: boolean;
    showAgentCursor?: boolean;
    openUrl?: (bundleId: string, url: string, signal: AbortSignal) => Promise<void>;
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
  };
  const states: unknown[] = [];
  const controller = new ComputerUseController({
    host,
    permissions: { status: () => ({ ...permissions }) },
    panel: panel as ComputerControlPanel,
    onState: (state) => states.push(state),
    selfPid: SELF_PID,
    idleStopMs: 10_000,
    waitTimeoutMs: 60_000,
    actionTimeoutMs: 5_000,
    ...(options.openUrl ? { openUrl: options.openUrl } : {}),
  });
  if (options.enabled !== false) {
    controller.setPreferences({
      enabled: true,
      showAgentCursor: options.showAgentCursor ?? true,
      blockedApps: ["com.apple.keychainaccess"],
    });
  }
  return { controller, host, sessions, permissions, panel, states };
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function release(
  controller: ComputerUseController,
  conversationId: string,
  reason: "turn-end" | "stop" | "retire" = "turn-end",
): boolean {
  return controller.release({
    version: 1,
    owner: { workspaceId: "ws_1", conversationId },
    reason,
  });
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
    expect(text(result)).toMatch(/turned off in Settings > General/);

    const ungranted = setup();
    ungranted.permissions.screenRecording = false;
    const missing = await ungranted.controller.invoke(request("list_apps", {}));
    expect(text(missing)).toBe(
      "Zeros needs Screen Recording access to use your Mac. The user can turn it on in Settings > General.",
    );
    ungranted.permissions.accessibility = false;
    expect(
      text(await ungranted.controller.invoke(request("list_apps", {}))),
    ).toMatch(/Accessibility and Screen Recording access .* turn them on/);
    expect(off.host.openSession).not.toHaveBeenCalled();
    expect(ungranted.host.openSession).not.toHaveBeenCalled();
  });

  it("acts in any app that is not blocked, without asking, and shows the control bar", async () => {
    const { controller, sessions, panel } = setup();
    const result = await controller.invoke(
      request("click", { pid: 501, element_token: "sdeadbeef:1" }),
    );
    expect(result.success).toBe(true);
    expect(text(result)).toBe("click done via screenshot");
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
      },
    ]);

    expect(release(controller, "conv_a")).toBe(true);
    expect(sessions[0]!.closed).toBe(true);
    expect(panel.hide).toHaveBeenCalled();
    expect(controller.state().holders).toEqual([]);
    // A retired chat's next turn acts at once too: there is no approval to forget.
    release(controller, "conv_a", "retire");
    const again = await controller.invoke(
      request("click", { pid: 501, element_token: "sdeadbeef:1" }, { turnId: "turn_2" }),
    );
    expect(again.success).toBe(true);
  });

  it("refuses Zeros and blocked apps before anything reaches the driver", async () => {
    const { controller, sessions } = setup();
    expect(
      text(
        await controller.invoke(
          request("click", { pid: 503, element_token: "sdeadbeef:1" }),
        ),
      ),
    ).toBe("Keychain Access is blocked in Settings > General.");
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
    ).toBe("Keychain Access is blocked in Settings > General.");

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

  it("queues a chat behind the chat using the same app and tells it why", async () => {
    const { controller, sessions } = setup();
    await controller.invoke(request("click", { pid: 501, element_token: "sdeadbeef:1" }));

    const waiting = controller.invoke(
      request(
        "type_text",
        { pid: 501, text: "from b" },
        { conversationId: "conv_b", agent: "claude" },
      ),
    );
    await vi.waitFor(() => expect(controller.state().waiting).toHaveLength(1));
    const state = controller.state();
    expect(state.waiting).toEqual([
      { workspaceId: "ws_1", conversationId: "conv_b", agent: "claude", app: "Safari" },
    ]);
    expect(computerUseWaitText(state, "conv_b")).toBe(
      "Waiting for Codex in another chat to finish using Safari",
    );
    // The waiting chat already has its own session and cursor.
    expect(sessions.map((session) => session.label)).toEqual(["Codex", "Claude Code"]);
    expect(sessions[1]!.actions()).toEqual([]);

    release(controller, "conv_a");
    const result = await waiting;
    expect(result.success).toBe(true);
    expect(sessions[1]!.actions()).toEqual([
      { tool: "type_text", args: { pid: 501, text: "from b" } },
    ]);
    expect(controller.state()).toMatchObject({
      holders: [{ conversationId: "conv_b", app: "Safari" }],
      waiting: [],
    });
  });

  it("gives up waiting for an app after the limit and leaves its line", async () => {
    vi.useFakeTimers();
    const { controller } = setup();
    await controller.invoke(request("click", { pid: 501, element_token: "sdeadbeef:1" }));
    const waiting = controller.invoke(
      request("click", { pid: 501, element_token: "sdeadbeef:1" }, { conversationId: "conv_b" }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.state().waiting).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(text(await waiting)).toBe(
      "Another chat is still using Safari. Try again when it finishes.",
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
      request("click", { pid: 501, element_token: "sdeadbeef:1" }, { conversationId: "conv_b" }),
    );
    await vi.waitFor(() => expect(controller.state().waiting).toHaveLength(1));
    controller.setPreferences({
      enabled: false,
      showAgentCursor: true,
      blockedApps: [],
    });
    expect(sessions.every((session) => session.closed)).toBe(true);
    expect(panel.hide).toHaveBeenCalled();
    expect(text(await waiting)).toMatch(/turned off/);
    expect(controller.state()).toEqual({ version: 1, holders: [], waiting: [] });
  });

  it("ends only the lease of an app that becomes blocked", async () => {
    const { controller, sessions, panel } = setup();
    await controller.invoke(request("click", { pid: 501, element_token: "sdeadbeef:1" }));
    await controller.invoke(request("type_text", { pid: 502, text: "hi" }));
    controller.setPreferences({
      enabled: true,
      showAgentCursor: true,
      blockedApps: ["com.apple.Safari"],
    });
    expect(sessions[0]!.closed).toBe(false);
    expect(controller.state().holders.map((holder) => holder.app)).toEqual(["TextEdit"]);
    expect(panel.show).toHaveBeenLastCalledWith({ title: "Codex", detail: "is using TextEdit" });
    expect(
      text(await controller.invoke(request("click", { pid: 501, element_token: "sdeadbeef:1" }))),
    ).toBe("Safari is blocked in Settings > General.");
    expect((await controller.invoke(request("type_text", { pid: 502, text: "ok" }))).success).toBe(true);
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

describe("Zeros computer use with access to every app", () => {
  it("acts without a card but still refuses blocked apps and Zeros", async () => {
    const t = setup();
    const clicked = await t.controller.invoke(
      request("click", { pid: 502, element_token: "sdeadbeef:1" }),
    );
    expect(clicked.success).toBe(true);
    expect(t.panel.show).toHaveBeenCalledWith(
      expect.objectContaining({ detail: "is using TextEdit" }),
    );
    const blocked = await t.controller.invoke(
      request("click", { pid: 503, element_token: "sdeadbeef:1" }),
    );
    expect(text(blocked)).toContain("blocked");
    const self = await t.controller.invoke(
      request("click", { pid: SELF_PID, element_token: "sdeadbeef:1" }),
    );
    expect(text(self)).toBe("Agents cannot control Zeros.");
  });

  it("opens a URL in an allowed app through Launch Services", async () => {
    const openUrl = vi.fn(async () => undefined);
    const t = setup({ openUrl });
    const opened = await t.controller.invoke(
      request("open_url", { bundle_id: "com.apple.safari", url: "https://cursor.com" }),
    );
    expect(text(opened)).toBe("Opened https://cursor.com/ in Safari.");
    expect(openUrl).toHaveBeenCalledWith("com.apple.Safari", "https://cursor.com/", expect.any(AbortSignal));
    const blocked = await t.controller.invoke(
      request("open_url", { bundle_id: "com.apple.keychainaccess", url: "https://cursor.com" }),
    );
    expect(opened.success && !blocked.success).toBe(true);
    expect(openUrl).toHaveBeenCalledTimes(1);
  });

  it("brings the named window forward when background keys are ambiguous", async () => {
    const t = setup({
      handle: (call) =>
        call.tool === "press_key" && call.args.delivery_mode === undefined
          ? Promise.resolve({
              isError: true,
              errorCode: null,
              text: "Background input refused (same_pid_keyboard_ambiguity): pid 501 owns 2 other eligible top-level window(s)",
              structured: null,
              images: [],
            })
          : undefined,
    });
    const pressed = await t.controller.invoke(
      request("press_key", { pid: 501, window_id: 11, key: "return" }),
    );
    expect(pressed.success).toBe(true);
    const keys = t.sessions[0]!.calls.filter((call) => call.tool === "press_key");
    expect(keys.map((call) => call.args.delivery_mode)).toEqual([undefined, "foreground"]);
  });

  it("reuses one app listing across a burst of actions, then reads it again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const t = setup();
      for (let index = 0; index < 3; index += 1) {
        await t.controller.invoke(request("click", { pid: 502, element_token: "sdeadbeef:1" }));
      }
      const listings = () => t.sessions[0]!.calls.filter((call) => call.tool === "list_apps");
      expect(listings()).toHaveLength(1);
      vi.setSystemTime(Date.now() + 29_000);
      await t.controller.invoke(request("click", { pid: 502, element_token: "sdeadbeef:1" }));
      expect(listings()).toHaveLength(1);
      vi.setSystemTime(Date.now() + 1_001);
      await t.controller.invoke(request("click", { pid: 502, element_token: "sdeadbeef:1" }));
      expect(listings()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Zeros computer use in parallel", () => {
  const click = (pid: number, conversationId = "conv_a", extra: Partial<ComputerToolInvokeRequest> = {}) =>
    request("click", { pid, element_token: "sdeadbeef:1" }, { conversationId, ...extra });

  it("lets chats in different apps act at the same time", async () => {
    const gate = deferred<ComputerDriverResult>();
    const started = deferred<void>();
    const t = setup({
      handle: (call) => {
        if (call.tool !== "click" || call.args.pid !== 501) return undefined;
        started.resolve();
        return gate.promise;
      },
    });
    const a = t.controller.invoke(click(501));
    await started.promise;
    // A's click is still in Safari while B finishes in TextEdit.
    const b = await t.controller.invoke(
      request("type_text", { pid: 502, text: "hi" }, { conversationId: "conv_b", agent: "claude" }),
    );
    expect(b.success).toBe(true);
    expect(t.sessions.map((session) => session.label)).toEqual(["Codex", "Claude Code"]);
    expect(
      t.controller.state().holders.map((holder) => [holder.conversationId, holder.app]),
    ).toEqual([
      ["conv_a", "Safari"],
      ["conv_b", "TextEdit"],
    ]);
    expect(t.controller.state().waiting).toEqual([]);
    expect(t.panel.show).toHaveBeenLastCalledWith({
      title: "Codex and Claude Code",
      detail: "are using Safari and TextEdit",
    });
    gate.resolve(ok("clicked"));
    expect((await a).success).toBe(true);
  });

  it("gives each chat one cursor session for all of its apps", async () => {
    const t = setup();
    await t.controller.invoke(click(501));
    await t.controller.invoke(request("type_text", { pid: 502, text: "hi" }));
    await t.controller.invoke(request("list_apps", {}, { conversationId: "conv_b", agent: "claude" }));
    expect(t.sessions).toHaveLength(2);
    const cursors = (session: FakeSession) =>
      session.calls.filter((call) => call.tool === "set_agent_cursor_enabled");
    expect(cursors(t.sessions[0]!)).toEqual([
      { tool: "set_agent_cursor_enabled", args: { session: "Codex", enabled: true } },
    ]);
    expect(cursors(t.sessions[1]!)).toEqual([
      { tool: "set_agent_cursor_enabled", args: { session: "Claude Code", enabled: true } },
    ]);
    // Looking around holds no app; acting does, and the bar names the last one.
    expect(t.controller.state().holders.map((holder) => [holder.conversationId, holder.app])).toEqual([
      ["conv_a", "Safari"],
      ["conv_a", "TextEdit"],
    ]);
    expect(t.panel.show).toHaveBeenLastCalledWith({ title: "Codex", detail: "is using TextEdit" });
  });

  it("lets one chat at a time bring a window forward", async () => {
    const gate = deferred<ComputerDriverResult>();
    const dragging = deferred<void>();
    const order: string[] = [];
    const t = setup({
      handle: (call) => {
        if (call.tool === "drag") {
          order.push("A drags");
          dragging.resolve();
          return gate.promise.then((result) => {
            order.push("A drag ends");
            return result;
          });
        }
        if (call.tool === "click") {
          order.push(call.args.delivery_mode === "foreground" ? "B clicks in front" : "B clicks");
        }
        return undefined;
      },
    });
    const drag = t.controller.invoke(
      request("drag", { pid: 501, window_id: 11, from_x: 1, from_y: 1, to_x: 9, to_y: 9 }),
    );
    await dragging.promise;
    const b = { conversationId: "conv_b", agent: "claude" as const };
    expect((await t.controller.invoke(request("click", { pid: 502, element_token: "sdeadbeef:1" }, b))).success).toBe(true);
    const modified = t.controller.invoke(
      request("click", { pid: 502, element_token: "sdeadbeef:1", modifiers: ["cmd"] }, b),
    );
    await settle();
    expect(order).toEqual(["A drags", "B clicks"]);
    gate.resolve(ok("dragged"));
    expect((await drag).success).toBe(true);
    expect((await modified).success).toBe(true);
    expect(order).toEqual(["A drags", "B clicks", "A drag ends", "B clicks in front"]);
  });

  it("does not hold the front for a chat that stops while waiting for it", async () => {
    const gate = deferred<ComputerDriverResult>();
    const dragging = deferred<void>();
    const t = setup({
      handle: (call) => {
        if (call.tool !== "drag") return undefined;
        dragging.resolve();
        return gate.promise;
      },
    });
    const drag = t.controller.invoke(
      request("drag", { pid: 501, window_id: 11, from_x: 1, from_y: 1, to_x: 9, to_y: 9 }),
    );
    await dragging.promise;
    const b = { conversationId: "conv_b", agent: "claude" as const };
    const modified = t.controller.invoke(
      request("click", { pid: 502, element_token: "sdeadbeef:1", modifiers: ["cmd"] }, b),
    );
    await settle();
    expect(release(t.controller, "conv_b", "stop")).toBe(true);
    expect(text(await modified)).toBe("The computer action was cancelled.");
    gate.resolve(ok("dragged"));
    expect((await drag).success).toBe(true);
    // The front is free again for the next chat.
    const c = await t.controller.invoke(
      request("click", { pid: 502, element_token: "sdeadbeef:1", modifiers: ["cmd"] }, { conversationId: "conv_c" }),
    );
    expect(c.success).toBe(true);
  });

  it("stops one chat on its composer Stop and every chat shown on the bar's Stop", async () => {
    const t = setup();
    const b = { agent: "claude" as const };
    await t.controller.invoke(click(501));
    await t.controller.invoke(click(502, "conv_b", b));
    expect(release(t.controller, "conv_a", "stop")).toBe(true);
    expect(t.sessions[0]!.closed).toBe(true);
    expect(t.sessions[1]!.closed).toBe(false);
    expect(t.panel.show).toHaveBeenLastCalledWith({ title: "Claude Code", detail: "is using TextEdit" });
    expect((await t.controller.invoke(click(502, "conv_b", b))).success).toBe(true);

    await t.controller.invoke(click(501, "conv_a", { turnId: "turn_2" }));
    expect(t.controller.stopFromUser()).toBe(true);
    expect(t.sessions.every((session) => session.closed)).toBe(true);
    expect(t.panel.hide).toHaveBeenCalled();
    expect(t.controller.state().holders).toEqual([]);
    expect(text(await t.controller.invoke(click(502, "conv_b", b)))).toMatch(/The user stopped computer use/);
    expect(text(await t.controller.invoke(click(501, "conv_a", { turnId: "turn_2" })))).toMatch(
      /The user stopped computer use/,
    );
  });

  it("refuses at once when two chats would wait for each other's apps", async () => {
    const t = setup();
    const b = { agent: "claude" as const };
    await t.controller.invoke(click(501));
    await t.controller.invoke(click(502, "conv_b", b));
    const aWaits = t.controller.invoke(click(502));
    await vi.waitFor(() => expect(t.controller.state().waiting).toHaveLength(1));
    expect(text(await t.controller.invoke(click(501, "conv_b", b)))).toBe(
      "Another chat is using Safari and is waiting for an app this chat is using. Try again when that chat finishes.",
    );
    expect(t.controller.state().waiting).toHaveLength(1);
    release(t.controller, "conv_b");
    expect((await aWaits).success).toBe(true);
    expect(t.controller.state().holders.map((holder) => holder.app)).toEqual(["Safari", "TextEdit"]);
  });

  it("ends every chat when the driver they share is lost", async () => {
    let lose = false;
    const t = setup({
      handle: (call) =>
        lose && call.tool === "click" ? Promise.reject(new ComputerDriverLostError()) : undefined,
    });
    await t.controller.invoke(click(501));
    await t.controller.invoke(click(502, "conv_b"));
    lose = true;
    expect(text(await t.controller.invoke(click(501)))).toBe(
      "Computer use stopped unexpectedly. Try again.",
    );
    expect(t.sessions.every((session) => session.closed)).toBe(true);
    expect(t.controller.state().holders).toEqual([]);
    expect(t.host.stop).toHaveBeenCalledTimes(1);
  });

  it("restarts the driver for new macOS access only once no other chat has a session", async () => {
    const t = setup();
    await t.controller.invoke(request("list_apps", {}));
    t.permissions.screenRecording = false;
    t.controller.permissionStatus();
    t.permissions.screenRecording = true;
    await t.controller.invoke(request("list_apps", {}, { conversationId: "conv_b" }));
    expect(t.host.stop).not.toHaveBeenCalled();
    expect(t.sessions[0]!.closed).toBe(false);
    release(t.controller, "conv_a");
    release(t.controller, "conv_b");
    await t.controller.invoke(request("list_apps", {}, { conversationId: "conv_c" }));
    expect(t.host.stop).toHaveBeenCalledTimes(1);
  });
});

describe("computer control bar", () => {
  it("names every chat acting now", () => {
    expect(computerControlBar([])).toBeNull();
    expect(computerControlBar([{ label: "Codex", app: "Safari" }])).toEqual({
      title: "Codex",
      detail: "is using Safari",
    });
    expect(
      computerControlBar([
        { label: "Claude Code", app: "Safari" },
        { label: "Claude Code 2", app: "Safari" },
      ]),
    ).toEqual({ title: "Claude Code and Claude Code 2", detail: "are using Safari" });
    expect(
      computerControlBar([
        { label: "Codex", app: "Safari" },
        { label: "Codex", app: "Notes" },
      ]),
    ).toEqual({ title: "2 agents", detail: "are using Safari and Notes" });
    expect(
      computerControlBar([
        { label: "Codex", app: "Safari" },
        { label: "Claude Code", app: "Notes" },
        { label: "Cursor", app: "Mail" },
      ]),
    ).toEqual({ title: "3 agents", detail: "are using 3 apps" });
    expect(computerControlBar([{ label: "Codex", app: null }])).toEqual({
      title: "Codex",
      detail: "is using your Mac",
    });
  });
});

describe("the shared app listing", () => {
  const PREVIEW = { name: "Preview", bundle_id: "com.apple.Preview", pid: 777, running: true };
  const listingCalls = (t: ReturnType<typeof setup>) =>
    t.sessions.flatMap((session) => session.calls).filter((call) => call.tool === "list_apps");

  it("serves every handler and chat from one driver read", async () => {
    const t = setup({ openUrl: async () => undefined });
    await t.controller.invoke(request("list_apps", {}));
    await t.controller.invoke(request("list_windows", {}));
    await t.controller.invoke(
      request("click", { pid: 502, element_token: "sdeadbeef:1" }, { conversationId: "conv_b" }),
    );
    expect(listingCalls(t)).toHaveLength(1);
    // A page opened in a running app keeps that app's process: no new read.
    await t.controller.invoke(
      request("open_url", { bundle_id: "com.apple.Safari", url: "https://example.com" }),
    );
    await t.controller.invoke(request("click", { pid: 501, element_token: "sdeadbeef:1" }));
    expect(listingCalls(t)).toHaveLength(1);
    // Notes was not running, so Launch Services starts it: the listing goes.
    await t.controller.invoke(
      request("open_url", { bundle_id: "com.apple.Notes", url: "https://example.com" }),
    );
    expect(listingCalls(t)).toHaveLength(1);
    await t.controller.invoke(request("click", { pid: 501, element_token: "sdeadbeef:1" }));
    expect(listingCalls(t)).toHaveLength(2);
  });

  it("acts in a launched app with the pid the launch reported", async () => {
    let launchText = "Launched Notes (pid 600) in background.";
    const t = setup({
      handle: (call) => (call.tool === "launch_app" ? Promise.resolve(ok(launchText)) : undefined),
    });
    await t.controller.invoke(request("open_app", { bundle_id: "com.apple.Notes" }));
    expect(listingCalls(t)).toHaveLength(1);
    const clicked = await t.controller.invoke(
      request("click", { pid: 600, element_token: "sdeadbeef:1" }),
    );
    expect(clicked.success).toBe(true);
    expect(listingCalls(t)).toHaveLength(1);
    expect(t.controller.state().holders.map((holder) => holder.app)).toEqual(["Notes"]);

    // Relaunching an app that runs keeps the listing even without a pid.
    launchText = "TextEdit is already open.";
    await t.controller.invoke(request("open_app", { bundle_id: "com.apple.TextEdit" }));
    await t.controller.invoke(request("click", { pid: 502, element_token: "sdeadbeef:1" }));
    expect(listingCalls(t)).toHaveLength(1);
  });

  it("reads the listing again after a launch that reports no pid", async () => {
    const t = setup();
    await t.controller.invoke(request("open_app", { bundle_id: "com.apple.Notes" }));
    expect(listingCalls(t)).toHaveLength(1);
    await t.controller.invoke(request("click", { pid: 501, element_token: "sdeadbeef:1" }));
    expect(listingCalls(t)).toHaveLength(2);
  });

  it("does not let a read that predates a launch undo it", async () => {
    const gate = deferred<ComputerDriverResult>();
    let reads = 0;
    const t = setup({
      handle: (call) => {
        if (call.tool === "launch_app") return Promise.resolve(ok("Launched Notes (pid 600) in background."));
        if (call.tool !== "list_apps") return undefined;
        reads += 1;
        return reads === 2 ? gate.promise : undefined;
      },
    });
    await t.controller.invoke(request("list_apps", {}));
    // Chat B starts a read for a pid the listing misses; it is still under way…
    const b = t.controller.invoke(
      request("click", { pid: 31_337, element_token: "sdeadbeef:1" }, { conversationId: "conv_b" }),
    );
    await vi.waitFor(() => expect(reads).toBe(2));
    // …when chat A launches Notes from the listing it already has.
    await t.controller.invoke(request("open_app", { bundle_id: "com.apple.Notes" }));
    gate.resolve(ok("apps", { apps: APPS }));
    expect((await b).success).toBe(false);
    // Notes keeps the pid its launch reported.
    expect(
      (await t.controller.invoke(request("click", { pid: 600, element_token: "sdeadbeef:1" }))).success,
    ).toBe(true);
    expect(reads).toBe(2);
  });

  it("reads again once when the listing misses an app", async () => {
    let apps = APPS;
    const t = setup({
      handle: (call) =>
        call.tool === "list_apps" ? Promise.resolve(ok("apps", { apps })) : undefined,
    });
    await t.controller.invoke(request("list_apps", {}));
    apps = [...APPS, PREVIEW];
    expect(
      (await t.controller.invoke(request("click", { pid: 777, element_token: "sdeadbeef:1" }))).success,
    ).toBe(true);
    expect(listingCalls(t)).toHaveLength(2);
    // A pid that is no app: one more read, then the refusal.
    expect(
      text(await t.controller.invoke(request("click", { pid: 31_337, element_token: "sdeadbeef:1" }))),
    ).toBe("No app you can control has process ID 31337. Call list_apps.");
    expect(listingCalls(t)).toHaveLength(3);
  });

  it("notices an app opened outside Zeros from its window", async () => {
    let apps = APPS;
    const notesWindow = { window_id: 21, pid: 600, app_name: "Notes", title: "Notes", bounds: null };
    const t = setup({
      handle: (call) => {
        if (call.tool === "list_apps") return Promise.resolve(ok("apps", { apps }));
        if (call.tool === "list_windows" && call.args.pid === undefined) {
          return Promise.resolve(ok("windows", { windows: [...WINDOWS, notesWindow] }));
        }
        return undefined;
      },
    });
    await t.controller.invoke(request("click", { pid: 502, element_token: "sdeadbeef:1" }));
    // Notes was opened from the shell: listed as not running, but it has a window.
    apps = APPS.map((app) => (app.name === "Notes" ? { ...app, pid: 600, running: true } : app));
    const listed = text(await t.controller.invoke(request("list_apps", { running_only: true })));
    expect(listed).toContain("Notes");
    expect(listingCalls(t)).toHaveLength(2);
    // Windows of processes the listing never names (the driver itself) do not
    // force another read.
    await t.controller.invoke(request("list_apps", {}));
    expect(listingCalls(t)).toHaveLength(2);
  });

  it("shares one read between chats asking at once", async () => {
    const gate = deferred<ComputerDriverResult>();
    const t = setup({
      handle: (call) => (call.tool === "list_apps" ? gate.promise : undefined),
    });
    const a = t.controller.invoke(request("list_apps", {}));
    const b = t.controller.invoke(request("list_apps", {}, { conversationId: "conv_b" }));
    await vi.waitFor(() => expect(listingCalls(t)).toHaveLength(1));
    await settle();
    expect(listingCalls(t)).toHaveLength(1);
    gate.resolve(ok("apps", { apps: APPS }));
    expect(text(await a)).toContain("TextEdit");
    expect(text(await b)).toContain("TextEdit");
    expect(listingCalls(t)).toHaveLength(1);
  });

  it("keeps a read going for other chats when the chat that started it stops", async () => {
    const gate = deferred<ComputerDriverResult>();
    const t = setup({
      // Like the driver, an aborted call stops.
      handle: (call, signal) =>
        call.tool === "list_apps"
          ? new Promise<ComputerDriverResult>((resolve, reject) => {
              void gate.promise.then(resolve);
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            })
          : undefined,
    });
    const cancel = new AbortController();
    const a = t.controller.invoke(request("list_apps", {}), cancel.signal);
    await vi.waitFor(() => expect(listingCalls(t)).toHaveLength(1));
    const b = t.controller.invoke(request("list_apps", {}, { conversationId: "conv_b" }));
    await settle();
    cancel.abort();
    expect(text(await a)).toBe("The computer action was cancelled.");
    gate.resolve(ok("apps", { apps: APPS }));
    expect(text(await b)).toContain("TextEdit");
    expect(listingCalls(t)).toHaveLength(1);
  });

  it("reads again on its own session when another chat's read fails on its session", async () => {
    const gate = deferred<ComputerDriverResult>();
    let reads = 0;
    const t = setup({
      handle: (call) => {
        if (call.tool !== "list_apps") return undefined;
        reads += 1;
        return reads === 1 ? gate.promise : Promise.resolve(ok("apps", { apps: APPS }));
      },
    });
    const a = t.controller.invoke(request("list_apps", {}));
    await vi.waitFor(() => expect(reads).toBe(1));
    const b = t.controller.invoke(request("list_apps", {}, { conversationId: "conv_b" }));
    await settle();
    gate.resolve({ ...ok("gone"), isError: true, errorCode: "session_unavailable" });
    expect(text(await a)).toMatch(/session expired/);
    expect(text(await b)).toContain("TextEdit");
    expect(t.sessions[1]!.calls.filter((call) => call.tool === "list_apps")).toHaveLength(1);
    expect(t.sessions[1]!.closed).toBe(false);
  });
});
