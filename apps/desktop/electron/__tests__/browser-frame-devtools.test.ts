import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  commands: new Map<string, (args: Record<string, unknown>, event: unknown) => unknown>(),
}));

vi.mock("../ipc/router", () => ({
  setCommand: (name: string, handler: (args: Record<string, unknown>, event: unknown) => unknown) =>
    mocks.commands.set(name, handler),
}));

import {
  browserFrameDevToolsScript,
  openBrowserFrameDevTools,
  parseBrowserFrameDevToolsRequest,
  registerBrowserFrameDevToolsCommand,
} from "../browser-frame-devtools";

const FRAME = "zeros-browser-tab-1";

class FakeContents extends EventEmitter {
  devToolsOpen = false;
  devToolsWebContents: {
    isDestroyed: () => boolean;
    executeJavaScript: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
  } | null = null;
  zoom = 1;
  mainFrame = { id: "main-frame" };
  openDevTools = vi.fn(() => {
    this.devToolsOpen = true;
  });
  inspectElement = vi.fn();
  isDevToolsOpened = () => this.devToolsOpen;
  isDestroyed = () => false;
  getZoomFactor = () => this.zoom;

  /** The DevTools frontend finished loading; `answer` is what the frontend
   * script resolves with. */
  loadFrontend(answer: () => Promise<unknown> = async () => true) {
    this.devToolsWebContents = {
      isDestroyed: () => false,
      executeJavaScript: vi.fn(answer),
      focus: vi.fn(),
    };
    this.emit("devtools-opened");
  }

  closeFrontend() {
    this.devToolsOpen = false;
    this.devToolsWebContents = null;
    this.emit("devtools-closed");
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function scriptOf(contents: FakeContents, call = 0): string {
  return String(contents.devToolsWebContents!.executeJavaScript.mock.calls[call]![0]);
}

describe("parseBrowserFrameDevToolsRequest", () => {
  it("accepts a Browser frame name with an optional point", () => {
    expect(parseBrowserFrameDevToolsRequest({ frameName: FRAME, x: 640.5, y: 12 })).toEqual({
      frameName: FRAME,
      point: { x: 640.5, y: 12 },
    });
    expect(parseBrowserFrameDevToolsRequest({ frameName: FRAME })).toEqual({
      frameName: FRAME,
      point: null,
    });
  });

  it.each([
    [{ frameName: "tab-1" }],
    [{ frameName: "zeros-browser-" }],
    [{ frameName: "zeros-browser-tab 1" }],
    [{ frameName: `zeros-browser-${"a".repeat(301)}` }],
    [{ frameName: 'zeros-browser-x"); alert(1); ("' }],
    [{ frameName: FRAME, x: 10 }],
    [{ frameName: FRAME, x: -1, y: 10 }],
    [{ frameName: FRAME, x: Number.NaN, y: 10 }],
    [{ frameName: FRAME, x: 10, y: Number.POSITIVE_INFINITY }],
    [{ frameName: FRAME, x: 10, y: 1_000_001 }],
    [{ frameName: FRAME, x: "10", y: 10 }],
  ])("rejects malformed request %#", (args) => {
    expect(parseBrowserFrameDevToolsRequest(args)).toBeNull();
  });
});

describe("browser:inspect-frame command", () => {
  let contents: FakeContents;
  let destroyed: boolean;

  function invoke(args: Record<string, unknown>, event?: unknown) {
    const handler = mocks.commands.get("browser:inspect-frame");
    if (!handler) throw new Error("browser:inspect-frame not registered");
    return handler(args, event ?? { sender: contents, senderFrame: contents.mainFrame });
  }

  beforeEach(() => {
    mocks.commands.clear();
    contents = new FakeContents();
    destroyed = false;
    registerBrowserFrameDevToolsCommand({
      mainWindow: { isDestroyed: () => destroyed, webContents: contents } as never,
    });
  });

  it("opens the app window's DevTools detached, never a preview window", () => {
    expect(invoke({ frameName: FRAME, x: 400, y: 300 })).toEqual({ ok: true });
    expect(contents.openDevTools).toHaveBeenCalledWith({ mode: "detach", activate: true });
  });

  it("rejects subframes, other WebContents and a closed window", () => {
    expect(invoke({ frameName: FRAME }, { sender: contents, senderFrame: { id: "page-frame" } })).toEqual({
      ok: false,
      reason: "unauthorized",
    });
    expect(invoke({ frameName: FRAME }, { sender: new FakeContents(), senderFrame: contents.mainFrame })).toEqual({
      ok: false,
      reason: "unauthorized",
    });
    destroyed = true;
    expect(invoke({ frameName: FRAME })).toEqual({ ok: false, reason: "unauthorized" });
    expect(contents.openDevTools).not.toHaveBeenCalled();
  });

  it("rejects malformed requests without opening DevTools", () => {
    expect(invoke({ frameName: "not-a-browser-frame" })).toEqual({
      ok: false,
      reason: "invalid-request",
    });
    expect(contents.openDevTools).not.toHaveBeenCalled();
  });
});

describe("openBrowserFrameDevTools", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("selects the tab's frame once the DevTools frontend has loaded", async () => {
    const contents = new FakeContents();
    openBrowserFrameDevTools(contents as never, { frameName: FRAME, point: { x: 400, y: 300 } });
    expect(contents.listenerCount("devtools-opened")).toBe(1);
    contents.loadFrontend();
    await settle();
    expect(contents.devToolsWebContents!.executeJavaScript).toHaveBeenCalledTimes(1);
    const script = scriptOf(contents);
    expect(script).toContain(JSON.stringify(FRAME));
    expect(script).toMatch(/, false, \d+\)$/);
    expect(contents.inspectElement).not.toHaveBeenCalled();
    expect(contents.listenerCount("devtools-opened")).toBe(0);
    expect(contents.listenerCount("devtools-closed")).toBe(0);
  });

  it("opens once for repeat clicks while loading and selects the latest tab", async () => {
    const contents = new FakeContents();
    openBrowserFrameDevTools(contents as never, { frameName: FRAME, point: null });
    openBrowserFrameDevTools(contents as never, { frameName: "zeros-browser-tab-2", point: null });
    expect(contents.openDevTools).toHaveBeenCalledTimes(1);
    contents.loadFrontend();
    await settle();
    expect(contents.devToolsWebContents!.executeJavaScript).toHaveBeenCalledTimes(1);
    expect(scriptOf(contents)).toContain('"zeros-browser-tab-2"');
  });

  it("raises and re-targets DevTools that is already open, without reopening it", async () => {
    const contents = new FakeContents();
    openBrowserFrameDevTools(contents as never, { frameName: FRAME, point: null });
    contents.loadFrontend();
    await settle();
    openBrowserFrameDevTools(contents as never, { frameName: "zeros-browser-tab-2", point: null });
    await settle();
    expect(contents.openDevTools).toHaveBeenCalledTimes(1);
    expect(contents.devToolsWebContents!.focus).not.toHaveBeenCalled();
    const script = scriptOf(contents, 1);
    expect(script).toContain('"zeros-browser-tab-2"');
    expect(script).toMatch(/, true, \d+\)$/);
  });

  it("falls back to inspecting the frame's point, scaled by the app zoom", async () => {
    const contents = new FakeContents();
    contents.zoom = 1.25;
    openBrowserFrameDevTools(contents as never, { frameName: FRAME, point: { x: 401, y: 299 } });
    contents.loadFrontend(async () => false);
    await settle();
    expect(contents.inspectElement).toHaveBeenCalledWith(501, 374);

    const failing = new FakeContents();
    openBrowserFrameDevTools(failing as never, { frameName: FRAME, point: { x: 10, y: 10 } });
    failing.loadFrontend(async () => {
      throw new Error("frontend changed");
    });
    await settle();
    expect(failing.inspectElement).toHaveBeenCalledWith(10, 10);
  });

  it("falls back when the frontend never answers", async () => {
    vi.useFakeTimers();
    const contents = new FakeContents();
    openBrowserFrameDevTools(contents as never, { frameName: FRAME, point: { x: 50, y: 60 } });
    contents.loadFrontend(() => new Promise(() => undefined));
    await vi.advanceTimersByTimeAsync(7_999);
    expect(contents.inspectElement).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(contents.inspectElement).toHaveBeenCalledWith(50, 60);
  });

  it("skips the fallback without a point or once DevTools has closed", async () => {
    const contents = new FakeContents();
    openBrowserFrameDevTools(contents as never, { frameName: FRAME, point: null });
    contents.loadFrontend(async () => false);
    await settle();
    expect(contents.inspectElement).not.toHaveBeenCalled();

    const closing = new FakeContents();
    let answer!: (value: boolean) => void;
    openBrowserFrameDevTools(closing as never, { frameName: FRAME, point: { x: 1, y: 1 } });
    closing.loadFrontend(() => new Promise((resolve) => (answer = resolve)));
    closing.devToolsOpen = false;
    answer(false);
    await settle();
    expect(closing.inspectElement).not.toHaveBeenCalled();
  });

  it("forgets a request when DevTools closes before loading", async () => {
    const contents = new FakeContents();
    openBrowserFrameDevTools(contents as never, { frameName: FRAME, point: null });
    contents.closeFrontend();
    expect(contents.listenerCount("devtools-opened")).toBe(0);
    openBrowserFrameDevTools(contents as never, { frameName: "zeros-browser-tab-2", point: null });
    expect(contents.openDevTools).toHaveBeenCalledTimes(2);
    contents.loadFrontend();
    await settle();
    expect(contents.devToolsWebContents!.executeJavaScript).toHaveBeenCalledTimes(1);
    expect(scriptOf(contents)).toContain('"zeros-browser-tab-2"');
  });
});

// The script runs inside Chromium's DevTools frontend. These tests replace its
// two module imports with a fake SDK shaped like the frontend's.
describe("browserFrameDevToolsScript", () => {
  const top = { isOutermostFrame: () => true };
  const nestedParent = { isOutermostFrame: () => false };

  function iframe(name: string | null) {
    return {
      nodeName: () => "IFRAME",
      getAttribute: (attribute: string) => (attribute === "name" ? name : null),
    };
  }

  function frame(id: string, parent: object | null, owner: object | null, name = "") {
    return { id, name, parentFrame: () => parent, getOwnerDOMNodeOrDocument: async () => owner };
  }

  function context(frameId: string, isDefault = true, result: unknown = { object: {} }) {
    return { frameId, isDefault, evaluate: vi.fn(async () => result) };
  }

  function run(
    script: string,
    env: {
      frames: unknown[];
      contexts: Array<ReturnType<typeof context>>;
      dockSide?: string;
    },
  ) {
    const setFlavor = vi.fn();
    const setIsDocked = vi.fn((_docked: boolean, done: () => void) => done());
    const ExecutionContext = class {};
    const SDK = {
      FrameManager: { FrameManager: { instance: () => ({ getAllFrames: () => env.frames }) } },
      TargetManager: {
        TargetManager: {
          instance: () => ({ models: () => [{ executionContexts: () => env.contexts }] }),
        },
      },
      RuntimeModel: { RuntimeModel: class {}, ExecutionContext },
    };
    const UI = {
      Context: { Context: { instance: () => ({ setFlavor }) } },
      DockController: {
        DockController: { instance: () => ({ dockSide: () => env.dockSide ?? "undocked" }) },
      },
    };
    const body = script
      .replace('import("devtools://devtools/bundled/core/sdk/sdk.js")', "Promise.resolve(fakeSdk)")
      .replace('import("devtools://devtools/bundled/ui/legacy/legacy.js")', "Promise.resolve(fakeUi)");
    expect(body).not.toContain("import(");
    const result = new Function("fakeSdk", "fakeUi", "InspectorFrontendHost", `return ${body};`)(
      SDK,
      UI,
      { setIsDocked },
    ) as Promise<boolean>;
    return { result, setFlavor, setIsDocked, ExecutionContext };
  }

  it("selects the frame whose app-owned <iframe> carries the tab name", async () => {
    // The page renamed its window; the <iframe name> attribute still matches.
    const tabFrame = frame("F1", top, iframe(FRAME), "renamed-by-page");
    const ctx = context("F1");
    const { result, setFlavor, ExecutionContext } = run(browserFrameDevToolsScript(FRAME), {
      frames: [frame("TOP", null, null), frame("F0", top, iframe("zeros-browser-tab-0")), tabFrame],
      contexts: [context("TOP"), context("F1", false), ctx],
    });
    await expect(result).resolves.toBe(true);
    expect(setFlavor).toHaveBeenCalledWith(ExecutionContext, ctx);
    expect(ctx.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        expression: "inspect(document.body ?? document.documentElement)",
        includeCommandLineAPI: true,
        silent: true,
      }),
      false,
      false,
    );
  });

  it("never matches a nested frame the page named after the tab", async () => {
    const nested = context("NESTED");
    const { result } = run(browserFrameDevToolsScript(FRAME, { waitMs: 0 }), {
      frames: [frame("NESTED", nestedParent, iframe(FRAME), FRAME)],
      contexts: [nested],
    });
    await expect(result).resolves.toBe(false);
    expect(nested.evaluate).not.toHaveBeenCalled();
  });

  it("reports failure when the frame never appears or inspect throws", async () => {
    await expect(
      run(browserFrameDevToolsScript(FRAME, { waitMs: 0 }), { frames: [], contexts: [] }).result,
    ).resolves.toBe(false);
    await expect(
      run(browserFrameDevToolsScript(FRAME), {
        frames: [frame("F1", top, iframe(FRAME))],
        contexts: [context("F1", true, { exceptionDetails: { text: "boom" } })],
      }).result,
    ).resolves.toBe(false);
    await expect(
      run(browserFrameDevToolsScript(FRAME), {
        frames: [frame("F1", top, iframe(FRAME))],
        contexts: [context("F1", true, { error: "Execution context was destroyed" })],
      }).result,
    ).resolves.toBe(false);
  });

  it("waits for the frame's execution context to appear", async () => {
    const env = { frames: [frame("F1", top, iframe(FRAME))], contexts: [] as Array<ReturnType<typeof context>> };
    const { result } = run(browserFrameDevToolsScript(FRAME, { waitMs: 2_000 }), env);
    setTimeout(() => env.contexts.push(context("F1")), 120);
    await expect(result).resolves.toBe(true);
  });

  it("raises only an undocked DevTools window, and only when asked", async () => {
    const env = () => ({ frames: [frame("F1", top, iframe(FRAME))], contexts: [context("F1")] });
    const raised = run(browserFrameDevToolsScript(FRAME, { raise: true }), env());
    await expect(raised.result).resolves.toBe(true);
    expect(raised.setIsDocked).toHaveBeenCalledWith(false, expect.any(Function));

    const docked = run(browserFrameDevToolsScript(FRAME, { raise: true }), { ...env(), dockSide: "right" });
    await expect(docked.result).resolves.toBe(true);
    expect(docked.setIsDocked).not.toHaveBeenCalled();

    const fresh = run(browserFrameDevToolsScript(FRAME), env());
    await expect(fresh.result).resolves.toBe(true);
    expect(fresh.setIsDocked).not.toHaveBeenCalled();
  });

  it("resolves false instead of throwing when the frontend's modules change", async () => {
    const script = browserFrameDevToolsScript(FRAME, { waitMs: 0 });
    const body = script
      .replace('import("devtools://devtools/bundled/core/sdk/sdk.js")', "Promise.resolve({})")
      .replace('import("devtools://devtools/bundled/ui/legacy/legacy.js")', "Promise.resolve({})");
    await expect(new Function(`return ${body};`)() as Promise<boolean>).resolves.toBe(false);
  });
});
