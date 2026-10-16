// ──────────────────────────────────────────────────────────
// The computer-use control bar
// ──────────────────────────────────────────────────────────
//
// While an agent controls the Mac, a small bar floats at the bottom center of
// the screen the user is on: "Codex is using Safari · Stop · esc". It is the
// Browser tab's control bar page in its own window, which never takes focus
// from the app being controlled and is left out of screen captures. Clicks
// pass through it everywhere except Stop, and Esc stops the agent from any
// app while the bar shows.
// ──────────────────────────────────────────────────────────

import type { IpcMain, IpcMainEvent, Rectangle } from "electron";

import {
  AGENT_CONTROL_CHANNELS,
  type AgentControlOverlayState,
} from "../agent-control/channels";
import {
  AGENT_CONTROL_FADE_MS,
  AGENT_CONTROL_RELEASE_MS,
  agentControlOverlayBounds,
} from "../agent-control/overlay";
import type {
  ComputerControlPanel,
  ComputerControlPresentation,
} from "./ports";

const ESCAPE = "Escape";

/** The parts of a `BrowserWindow` the bar uses. */
export interface ControlPanelWindow {
  readonly webContents: {
    send(channel: string, ...args: unknown[]): void;
    isDestroyed(): boolean;
  };
  isDestroyed(): boolean;
  setBounds(bounds: Rectangle): void;
  showInactive(): void;
  hide(): void;
  destroy(): void;
  setIgnoreMouseEvents(ignore: boolean, options?: { forward?: boolean }): void;
  once(event: "closed", listener: () => void): unknown;
}

export interface ComputerControlPanelHost extends ComputerControlPanel {
  dispose(): void;
}

export function createComputerControlPanel<
  W extends ControlPanelWindow = ControlPanelWindow,
>(options: {
  ipc: Pick<IpcMain, "on" | "removeListener">;
  /** A hidden, transparent, non-focusable window that is excluded from
   * captures and floats over full-screen apps. */
  createWindow(): W;
  load(window: W): Promise<void>;
  /** The work area of the display the user is on. */
  workArea(): Rectangle;
  shortcuts: {
    register(accelerator: string, callback: () => void): boolean;
    unregister(accelerator: string): void;
  };
  /** Stop or Esc. */
  onStop(): void;
  fadeMs?: number;
  releaseMs?: number;
}): ComputerControlPanelHost {
  const fadeMs = options.fadeMs ?? AGENT_CONTROL_FADE_MS;
  const releaseMs = options.releaseMs ?? AGENT_CONTROL_RELEASE_MS;
  let window: ControlPanelWindow | null = null;
  let ready = false;
  let state: AgentControlOverlayState = {
    title: "",
    detail: "",
    visible: false,
  };
  let escapeHeld = false;
  let escapeSuspended = 0;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  let releaseTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const clearTimers = () => {
    if (hideTimer) clearTimeout(hideTimer);
    if (releaseTimer) clearTimeout(releaseTimer);
    hideTimer = null;
    releaseTimer = null;
  };

  const live = (): ControlPanelWindow | null =>
    window && !window.isDestroyed() ? window : null;

  const send = () => {
    const current = live();
    if (!ready || !current || current.webContents.isDestroyed()) return;
    current.webContents.send(AGENT_CONTROL_CHANNELS.state, state);
  };

  const stopFromUser = () => {
    if (state.visible) options.onStop();
  };

  /** Esc belongs to the bar only while it shows and the agent is not
   * pressing Escape itself. */
  const syncEscape = () => {
    const want = state.visible && escapeSuspended === 0 && !disposed;
    if (want && !escapeHeld) {
      try {
        escapeHeld = options.shortcuts.register(ESCAPE, stopFromUser);
      } catch {
        escapeHeld = false;
      }
    } else if (!want && escapeHeld) {
      escapeHeld = false;
      try {
        options.shortcuts.unregister(ESCAPE);
      } catch {
        // Already released.
      }
    }
  };

  const release = () => {
    clearTimers();
    const current = window;
    window = null;
    ready = false;
    if (current && !current.isDestroyed()) current.destroy();
  };

  const create = (): ControlPanelWindow => {
    const created = options.createWindow();
    window = created;
    ready = false;
    created.setIgnoreMouseEvents(true, { forward: true });
    created.once("closed", () => {
      if (window === created) {
        window = null;
        ready = false;
      }
    });
    void options.load(created).catch(() => undefined);
    return created;
  };

  /** Only the bar page's own main frame may report readiness, Stop or the
   * pointer. */
  const fromPanel = (event: IpcMainEvent): boolean => {
    const current = live();
    return Boolean(
      current &&
        event.sender === current.webContents &&
        event.senderFrame &&
        event.senderFrame === event.sender.mainFrame,
    );
  };

  const onReady = (event: IpcMainEvent) => {
    if (!fromPanel(event)) return;
    ready = true;
    send();
  };
  const onStop = (event: IpcMainEvent) => {
    if (fromPanel(event)) stopFromUser();
  };
  const onPointer = (event: IpcMainEvent, interactive: unknown) => {
    if (!fromPanel(event)) return;
    live()?.setIgnoreMouseEvents(!(interactive === true && state.visible), {
      forward: true,
    });
  };
  options.ipc.on(AGENT_CONTROL_CHANNELS.ready, onReady);
  options.ipc.on(AGENT_CONTROL_CHANNELS.stop, onStop);
  options.ipc.on(AGENT_CONTROL_CHANNELS.pointer, onPointer);

  const show = (presentation: ComputerControlPresentation) => {
    if (disposed) return;
    const bounds = agentControlOverlayBounds(options.workArea());
    if (!bounds) return;
    clearTimers();
    const current = live() ?? create();
    current.setBounds(bounds);
    const changed =
      !state.visible ||
      state.title !== presentation.title ||
      state.detail !== presentation.detail;
    state = {
      title: presentation.title,
      detail: presentation.detail,
      visible: true,
    };
    current.showInactive();
    if (changed) send();
    syncEscape();
  };

  const hide = () => {
    if (!state.visible) return;
    state = { ...state, visible: false };
    syncEscape();
    send();
    const current = live();
    if (!current) return;
    current.setIgnoreMouseEvents(true, { forward: true });
    clearTimers();
    hideTimer = setTimeout(() => {
      hideTimer = null;
      if (state.visible) return;
      live()?.hide();
      releaseTimer = setTimeout(() => {
        releaseTimer = null;
        if (!state.visible) release();
      }, releaseMs);
    }, fadeMs);
  };

  return {
    show,
    hide,
    async withoutEscape(work) {
      escapeSuspended += 1;
      syncEscape();
      try {
        return await work();
      } finally {
        escapeSuspended -= 1;
        syncEscape();
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      state = { ...state, visible: false };
      syncEscape();
      release();
      options.ipc.removeListener(AGENT_CONTROL_CHANNELS.ready, onReady);
      options.ipc.removeListener(AGENT_CONTROL_CHANNELS.stop, onStop);
      options.ipc.removeListener(AGENT_CONTROL_CHANNELS.pointer, onPointer);
    },
  };
}
