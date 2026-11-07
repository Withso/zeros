import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AGENT_CONTROL_CHANNELS,
  type AgentControlOverlayState,
} from "../agent-control/channels";
import { createComputerControlPanel } from "../computer-use/control-panel";

type Handler = (event: unknown, ...args: unknown[]) => void;

class FakeContents {
  readonly mainFrame = { id: "main" };
  readonly sent: AgentControlOverlayState[] = [];
  destroyed = false;
  send = vi.fn((channel: string, state: AgentControlOverlayState) => {
    if (channel === AGENT_CONTROL_CHANNELS.state) this.sent.push(state);
  });
  isDestroyed = () => this.destroyed;
}

class FakePanelWindow {
  readonly webContents = new FakeContents();
  destroyed = false;
  visible = false;
  bounds: unknown = null;
  ignoring: Array<{ ignore: boolean; forward?: boolean }> = [];
  private closed: (() => void) | null = null;
  isDestroyed = () => this.destroyed;
  setBounds = vi.fn((bounds: unknown) => {
    this.bounds = bounds;
  });
  showInactive = vi.fn(() => {
    this.visible = true;
  });
  hide = vi.fn(() => {
    this.visible = false;
  });
  destroy = vi.fn(() => {
    this.destroyed = true;
    this.webContents.destroyed = true;
    this.closed?.();
  });
  setIgnoreMouseEvents = vi.fn(
    (ignore: boolean, options?: { forward?: boolean }) => {
      this.ignoring.push({ ignore, ...options });
    },
  );
  once(_event: "closed", listener: () => void) {
    this.closed = listener;
    return this;
  }
}

function setup() {
  const handlers = new Map<string, Handler>();
  const ipc = {
    on: vi.fn((channel: string, handler: Handler) => {
      handlers.set(channel, handler);
    }),
    removeListener: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  };
  const fire = (
    channel: string,
    sender: FakeContents,
    frame: unknown = sender.mainFrame,
    ...args: unknown[]
  ) => handlers.get(channel)?.({ sender, senderFrame: frame }, ...args);
  const windows: FakePanelWindow[] = [];
  const onStop = vi.fn();
  const load = vi.fn(async () => undefined);
  const panel = createComputerControlPanel({
    ipc: ipc as never,
    createWindow: () => {
      const window = new FakePanelWindow();
      windows.push(window);
      return window;
    },
    load,
    workArea: () => ({ x: 0, y: 25, width: 1440, height: 875 }),
    onStop,
    fadeMs: 160,
    releaseMs: 30_000,
  });
  return {
    panel,
    handlers,
    fire,
    windows,
    onStop,
    load,
  };
}

const SAFARI = { title: "Codex", detail: "is using Safari" };

describe("computer-use control bar", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("floats at the bottom center of the user's screen without taking focus or clicks", () => {
    const { panel, windows, load } = setup();
    expect(windows).toHaveLength(0);
    panel.show(SAFARI);
    expect(windows).toHaveLength(1);
    const window = windows[0]!;
    expect(load).toHaveBeenCalledWith(window);
    // Same rectangle the Browser tab's bar uses over a page.
    expect(window.bounds).toEqual({ x: 416, y: 834, width: 608, height: 66 });
    expect(window.showInactive).toHaveBeenCalled();
    expect(window.ignoring[0]).toEqual({ ignore: true, forward: true });
  });

  it("sends what to show once the page listens", () => {
    const { panel, windows, fire } = setup();
    panel.show(SAFARI);
    const window = windows[0]!;
    expect(window.webContents.sent).toEqual([]);
    fire(AGENT_CONTROL_CHANNELS.ready, window.webContents);
    expect(window.webContents.sent).toEqual([
      { title: "Codex", detail: "is using Safari", visible: true, escapeHint: false },
    ]);
    panel.show(SAFARI);
    expect(window.webContents.sent).toHaveLength(1);
    panel.show({ title: "Codex", detail: "is using TextEdit" });
    expect(window.webContents.sent.at(-1)).toEqual({
      title: "Codex",
      detail: "is using TextEdit",
      visible: true,
      escapeHint: false,
    });
  });

  it("never claims Esc: agents work while the user keeps typing in other apps", () => {
    const { panel, windows, fire } = setup();
    panel.show(SAFARI);
    fire(AGENT_CONTROL_CHANNELS.ready, windows[0]!.webContents);
    // The page is told Esc does not stop the agent here, so it shows no hint
    // and listens for no key; only Stop does.
    expect(windows[0]!.webContents.sent.every((state) => (state as { escapeHint?: boolean }).escapeHint === false)).toBe(true);
    expect(Object.keys(panel)).not.toContain("withoutEscape");
  });

  it("takes clicks only while the pointer is over Stop", () => {
    const { panel, windows, fire } = setup();
    panel.show(SAFARI);
    const window = windows[0]!;
    fire(AGENT_CONTROL_CHANNELS.pointer, window.webContents, undefined, true);
    expect(window.ignoring.at(-1)).toEqual({ ignore: false, forward: true });
    fire(AGENT_CONTROL_CHANNELS.pointer, window.webContents, undefined, false);
    expect(window.ignoring.at(-1)).toEqual({ ignore: true, forward: true });
    // Another page, or a subframe, cannot open the bar to clicks.
    const other = new FakeContents();
    fire(AGENT_CONTROL_CHANNELS.pointer, other, undefined, true);
    fire(AGENT_CONTROL_CHANNELS.pointer, window.webContents, { id: "sub" }, true);
    expect(window.ignoring.at(-1)).toEqual({ ignore: true, forward: true });
  });

  it("accepts Stop only from its own visible page", () => {
    const { panel, windows, fire, onStop } = setup();
    panel.show(SAFARI);
    const window = windows[0]!;
    fire(AGENT_CONTROL_CHANNELS.stop, new FakeContents());
    fire(AGENT_CONTROL_CHANNELS.stop, window.webContents, { id: "sub" });
    expect(onStop).not.toHaveBeenCalled();
    fire(AGENT_CONTROL_CHANNELS.stop, window.webContents);
    expect(onStop).toHaveBeenCalledTimes(1);
    panel.hide();
    fire(AGENT_CONTROL_CHANNELS.stop, window.webContents);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("fades out, hides, and later releases its window", () => {
    const { panel, windows, fire } = setup();
    panel.show(SAFARI);
    const window = windows[0]!;
    fire(AGENT_CONTROL_CHANNELS.ready, window.webContents);
    panel.hide();
    expect(window.webContents.sent.at(-1)).toMatchObject({ visible: false });
    expect(window.visible).toBe(true);
    vi.advanceTimersByTime(160);
    expect(window.visible).toBe(false);
    expect(window.destroyed).toBe(false);
    vi.advanceTimersByTime(30_000);
    expect(window.destroyed).toBe(true);
    panel.show(SAFARI);
    expect(windows).toHaveLength(2);
  });

  it("comes straight back when shown again during the fade", () => {
    const { panel, windows } = setup();
    panel.show(SAFARI);
    panel.hide();
    vi.advanceTimersByTime(100);
    panel.show(SAFARI);
    vi.advanceTimersByTime(60_000);
    expect(windows).toHaveLength(1);
    expect(windows[0]!.visible).toBe(true);
    expect(windows[0]!.destroyed).toBe(false);
  });

  it("lets go of everything when disposed", () => {
    const { panel, windows, handlers } = setup();
    panel.show(SAFARI);
    panel.dispose();
    expect(windows[0]!.destroyed).toBe(true);
    expect(handlers.size).toBe(0);
    panel.show(SAFARI);
    expect(windows).toHaveLength(1);
  });
});
