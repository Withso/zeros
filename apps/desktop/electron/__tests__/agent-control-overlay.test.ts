import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AGENT_CONTROL_CHANNELS,
  type AgentControlOverlayState,
} from "../agent-control/channels";
import {
  agentControlOverlayBounds,
  agentControlOverlayWebPreferences,
  createAgentControlOverlayHost,
  type AgentControlPresentation,
} from "../agent-control/overlay";

type Handler = (event: unknown, ...args: unknown[]) => void;

class FakeContents {
  readonly mainFrame = { id: "main" };
  readonly sent: AgentControlOverlayState[] = [];
  readonly listeners = new Map<string, Handler[]>();
  destroyed = false;
  focused = false;
  windowOpenHandler: (() => { action: string }) | null = null;
  send = vi.fn((channel: string, state: AgentControlOverlayState) => {
    if (channel === AGENT_CONTROL_CHANNELS.state) this.sent.push(state);
  });
  close = vi.fn(() => {
    this.destroyed = true;
  });
  focus = vi.fn(() => {
    this.focused = true;
  });
  isDestroyed = () => this.destroyed;
  isFocused = () => this.focused;
  setWindowOpenHandler(handler: () => { action: string }) {
    this.windowOpenHandler = handler;
  }
  on(name: string, handler: Handler) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), handler]);
    return this;
  }
  emit(name: string, event: unknown = {}) {
    for (const handler of this.listeners.get(name) ?? []) handler(event);
  }
}

class FakeView {
  readonly webContents = new FakeContents();
  bounds: unknown = null;
  background: string | null = null;
  setBounds = vi.fn((bounds: unknown) => {
    this.bounds = bounds;
  });
  setBackgroundColor = vi.fn((color: string) => {
    this.background = color;
  });
}

class FakeWindow {
  children: unknown[] = [];
  destroyed = false;
  readonly contentView = {
    addChildView: vi.fn((view: unknown) => {
      this.children = [...this.children.filter((child) => child !== view), view];
    }),
    removeChildView: vi.fn((view: unknown) => {
      this.children = this.children.filter((child) => child !== view);
    }),
  };
  isDestroyed = () => this.destroyed;
}

function fakeIpc() {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    on: vi.fn((channel: string, handler: Handler) => {
      handlers.set(channel, handler);
    }),
    removeListener: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
    fire(channel: string, sender: FakeContents, frame = sender.mainFrame) {
      handlers.get(channel)?.({ sender, senderFrame: frame });
    },
  };
}

function setup() {
  const ipc = fakeIpc();
  const views: FakeView[] = [];
  const onStop = vi.fn();
  const load = vi.fn(async () => undefined);
  const host = createAgentControlOverlayHost({
    ipc: ipc as never,
    createView: () => {
      const view = new FakeView();
      views.push(view);
      return view as never;
    },
    load,
    onStop,
    fadeMs: 160,
  });
  const window = new FakeWindow();
  const page = new FakeView();
  window.contentView.addChildView(page);
  const presentation = (
    overrides: Partial<AgentControlPresentation> = {},
  ): AgentControlPresentation =>
    ({
      title: "Codex",
      detail: "Clicking…",
      window,
      above: page,
      bounds: { x: 300, y: 80, width: 900, height: 700 },
      ...overrides,
    }) as AgentControlPresentation;
  return { ipc, views, onStop, load, host, window, page, presentation };
}

describe("agent control bar overlay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sits bottom-center over the page with room for the floating shadow", () => {
    expect(
      agentControlOverlayBounds({ x: 300, y: 80, width: 900, height: 700 }),
    ).toEqual({ x: 446, y: 714, width: 608, height: 66 });
    // A narrow page lends its full width and the bar truncates its detail.
    expect(
      agentControlOverlayBounds({ x: 10, y: 20, width: 400, height: 300 }),
    ).toEqual({ x: 10, y: 254, width: 400, height: 66 });
    expect(
      agentControlOverlayBounds({ x: 0, y: 0, width: 239, height: 300 }),
    ).toBeNull();
    expect(
      agentControlOverlayBounds({ x: 0, y: 0, width: 400, height: 119 }),
    ).toBeNull();
  });

  it("locks the bar page down like every other Zeros renderer", () => {
    expect(agentControlOverlayWebPreferences("/app/preload.cjs")).toMatchObject(
      {
        preload: "/app/preload.cjs",
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
    );
  });

  it("stacks a transparent bar above the page and sends state once the page listens", () => {
    const { host, views, window, page, presentation, ipc, load } = setup();
    host.show("browser_a", presentation());

    const bar = views[0]!;
    expect(load).toHaveBeenCalledWith(bar);
    expect(bar.background).toBe("#00000000");
    expect(window.children).toEqual([page, bar]);
    expect(bar.bounds).toEqual({ x: 446, y: 714, width: 608, height: 66 });
    expect(bar.webContents.windowOpenHandler?.()).toEqual({ action: "deny" });
    const navigation = { preventDefault: vi.fn() };
    bar.webContents.emit("will-navigate", navigation);
    expect(navigation.preventDefault).toHaveBeenCalled();
    expect(bar.webContents.sent).toEqual([]);

    ipc.fire(AGENT_CONTROL_CHANNELS.ready, bar.webContents);
    expect(bar.webContents.sent).toEqual([
      { title: "Codex", detail: "Clicking…", visible: true },
    ]);

    host.show("browser_a", presentation({ detail: "Typing…" }));
    host.show("browser_a", presentation({ detail: "Typing…" }));
    expect(bar.webContents.sent.at(-1)).toEqual({
      title: "Codex",
      detail: "Typing…",
      visible: true,
    });
    expect(bar.webContents.sent).toHaveLength(2);
    expect(views).toHaveLength(1);
  });

  it("restacks the bar when the page is re-added above it", () => {
    const { host, views, window, page, presentation } = setup();
    host.show("browser_a", presentation());
    const bar = views[0]!;
    window.contentView.addChildView(page);
    expect(window.children).toEqual([bar, page]);
    host.show("browser_a", presentation({ raise: true }));
    expect(window.children).toEqual([page, bar]);
  });

  it("fades out before leaving the window and cancels the removal if shown again", () => {
    const { host, views, window, page, presentation, ipc } = setup();
    host.show("browser_a", presentation());
    const bar = views[0]!;
    ipc.fire(AGENT_CONTROL_CHANNELS.ready, bar.webContents);

    host.hide("browser_a");
    expect(bar.webContents.sent.at(-1)?.visible).toBe(false);
    expect(window.children).toEqual([page, bar]);
    vi.advanceTimersByTime(100);
    host.show("browser_a", presentation());
    vi.advanceTimersByTime(200);
    expect(window.children).toEqual([page, bar]);
    expect(bar.webContents.sent.at(-1)?.visible).toBe(true);

    host.hide("browser_a");
    vi.advanceTimersByTime(160);
    expect(window.children).toEqual([page]);
    // The renderer stays ready for the user switching back or the next turn.
    expect(bar.webContents.close).not.toHaveBeenCalled();
  });

  it("releases the renderer of a bar that stays off screen", () => {
    const { host, views, window, page, presentation } = setup();
    host.show("browser_a", presentation());
    host.hide("browser_a", { immediate: true });
    vi.advanceTimersByTime(20_000);
    // Coming back in time reuses the same bar.
    host.show("browser_a", presentation());
    expect(views).toHaveLength(1);
    expect(window.children).toEqual([page, views[0]]);

    host.hide("browser_a");
    vi.advanceTimersByTime(160 + 29_000);
    // Repeated hides while parked do not postpone the release.
    host.hide("browser_a", { immediate: true });
    vi.advanceTimersByTime(1_000);
    expect(views[0]!.webContents.close).toHaveBeenCalled();
    host.show("browser_a", presentation());
    expect(views).toHaveLength(2);
    expect(window.children).toEqual([page, views[1]]);
  });

  it("removes the bar at once when the page leaves its surface", () => {
    const { host, views, window, page, presentation } = setup();
    host.show("browser_a", presentation());
    host.hide("browser_a", { immediate: true });
    expect(window.children).toEqual([page]);
    expect(views[0]!.webContents.close).not.toHaveBeenCalled();
    // Too small to hold the bar counts as leaving.
    host.show("browser_a", presentation());
    host.show(
      "browser_a",
      presentation({ bounds: { x: 0, y: 0, width: 200, height: 400 } }),
    );
    expect(window.children).toEqual([page]);
  });

  it("returns focus to the page when Stop hands it back", () => {
    const { host, views, page, presentation } = setup();
    host.show("browser_a", presentation());
    views[0]!.webContents.focused = true;
    host.hide("browser_a");
    expect(page.webContents.focus).toHaveBeenCalled();
  });

  it("accepts Stop only from a visible bar's own main frame", () => {
    const { host, views, presentation, ipc, onStop } = setup();
    host.show("browser_a", presentation());
    const bar = views[0]!;

    ipc.fire(AGENT_CONTROL_CHANNELS.stop, new FakeContents());
    ipc.fire(AGENT_CONTROL_CHANNELS.stop, bar.webContents, { id: "child" });
    expect(onStop).not.toHaveBeenCalled();

    ipc.fire(AGENT_CONTROL_CHANNELS.stop, bar.webContents);
    expect(onStop).toHaveBeenCalledWith("browser_a");

    host.hide("browser_a");
    ipc.fire(AGENT_CONTROL_CHANNELS.stop, bar.webContents);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("gives each page its own bar and releases it with the session", () => {
    const { host, views, window, page, presentation, ipc } = setup();
    const otherPage = new FakeView();
    window.contentView.addChildView(otherPage);
    host.show("browser_a", presentation());
    host.show(
      "browser_b",
      presentation({ above: otherPage as never, title: "Cursor" }),
    );
    expect(views).toHaveLength(2);

    host.dispose("browser_a");
    expect(views[0]!.webContents.close).toHaveBeenCalled();
    expect(window.children).toEqual([page, otherPage, views[1]]);

    host.disposeAll();
    expect(views[1]!.webContents.close).toHaveBeenCalled();
    expect(window.children).toEqual([page, otherPage]);
    expect(ipc.handlers.size).toBe(0);
  });

  it("replaces a bar whose renderer crashed", () => {
    const { host, views, window, page, presentation } = setup();
    host.show("browser_a", presentation());
    views[0]!.webContents.emit("render-process-gone");
    expect(window.children).toEqual([page]);
    host.show("browser_a", presentation());
    expect(views).toHaveLength(2);
    expect(window.children).toEqual([page, views[1]]);
  });
});
