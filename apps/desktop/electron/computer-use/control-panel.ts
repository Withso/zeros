// ──────────────────────────────────────────────────────────
// The computer-use control bar
// ──────────────────────────────────────────────────────────
//
// While an agent controls the Mac, a small bar floats at the bottom center of
// the screen the user is on: "Codex is using Safari · Stop". It is the
// Browser tab's control bar page in its own window, which never takes focus
// from the app being controlled and is left out of screen captures. Clicks
// pass through it everywhere except Stop. Agents work in the background while
// the user keeps using other apps, so the bar never claims a key: Esc keeps
// working in whatever app the user is in.
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
  /** The bar's Stop. */
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
    escapeHint: false,
  };
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
      escapeHint: false,
    };
    current.showInactive();
    if (changed) send();
  };

  const hide = () => {
    if (!state.visible) return;
    state = { ...state, visible: false };
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
    dispose() {
      if (disposed) return;
      disposed = true;
      state = { ...state, visible: false };
      release();
      options.ipc.removeListener(AGENT_CONTROL_CHANNELS.ready, onReady);
      options.ipc.removeListener(AGENT_CONTROL_CHANNELS.stop, onStop);
      options.ipc.removeListener(AGENT_CONTROL_CHANNELS.pointer, onPointer);
    },
  };
}
