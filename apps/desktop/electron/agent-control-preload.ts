// ──────────────────────────────────────────────────────────
// Zeros Electron — agent control bar preload
// ──────────────────────────────────────────────────────────
//
// The bar page (`agent-control.html`), over a live Browser page or floating
// over other apps during computer use, gets exactly three capabilities:
// receive what to show, ask main to stop the agent, and say whether the
// pointer is over Stop. It never reaches the app's command table.
// ──────────────────────────────────────────────────────────

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import { AGENT_CONTROL_CHANNELS } from "./agent-control/channels";

contextBridge.exposeInMainWorld("__ZEROS_AGENT_CONTROL__", {
  onState(listener: (state: unknown) => void): () => void {
    const handler = (_event: IpcRendererEvent, state: unknown) =>
      listener(state);
    ipcRenderer.on(AGENT_CONTROL_CHANNELS.state, handler);
    ipcRenderer.send(AGENT_CONTROL_CHANNELS.ready);
    return () => {
      ipcRenderer.removeListener(AGENT_CONTROL_CHANNELS.state, handler);
    };
  },
  stop(): void {
    ipcRenderer.send(AGENT_CONTROL_CHANNELS.stop);
  },
  setInteractive(interactive: boolean): void {
    ipcRenderer.send(AGENT_CONTROL_CHANNELS.pointer, interactive === true);
  },
});
