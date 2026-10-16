/** IPC between main and the agent control bar page. Shared with its preload,
 * so this module must stay free of Node and Electron runtime imports. */
export const AGENT_CONTROL_CHANNELS = {
  /** Page → main: listening; reply with the current state. */
  ready: "zeros:agent-control:ready",
  /** Main → page: `AgentControlOverlayState`. */
  state: "zeros:agent-control:state",
  /** Page → main: the user pressed Stop or Esc. */
  stop: "zeros:agent-control:stop",
  /** Page → main: whether the pointer is over Stop. A bar floating over
   * other apps takes clicks only there. */
  pointer: "zeros:agent-control:pointer",
} as const;

export interface AgentControlOverlayState {
  /** Who is in control, such as "Codex". */
  title: string;
  /** What it is doing right now. */
  detail: string;
  visible: boolean;
}
