// What the computer-use controller needs from the driver, macOS and the
// control panel. Main wires the real implementations; tests use fakes.

export interface ComputerDriverImage {
  data: string;
  mimeType: string;
}

/** One driver tool result, independent of the SDK's generated types. */
export interface ComputerDriverResult {
  isError: boolean;
  errorCode: string | null;
  text: string;
  structured: Record<string, unknown> | null;
  images: ComputerDriverImage[];
}

/** The only driver tools Zeros calls. */
export type ComputerDriverTool =
  | "list_apps"
  | "list_windows"
  | "get_window_state"
  | "click"
  | "type_text"
  | "press_key"
  | "scroll"
  | "drag"
  | "launch_app"
  | "set_agent_cursor_enabled"
  | "set_agent_cursor_motion";

/** A trusted driver session for one chat's lease. Its label is the agent's
 * name, which the driver shows on its cursor. */
export interface ComputerDriverSession {
  call(
    tool: ComputerDriverTool,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<ComputerDriverResult>;
  /** Revoke the session. Idempotent. */
  close(): void;
}

export interface ComputerDriverHost {
  /** Start the driver if needed and open a session. */
  openSession(label: string, signal: AbortSignal): Promise<ComputerDriverSession>;
  /** Stop the driver. Idempotent; the next session starts it again. */
  stop(): Promise<void>;
}

/** The driver process exited or its channel broke. The host starts a new one,
 * after a backoff, for the next session. */
export class ComputerDriverLostError extends Error {
  constructor(message = "The computer-use driver stopped.") {
    super(message);
    this.name = "ComputerDriverLostError";
  }
}

export interface ComputerPermissionStatus {
  accessibility: boolean;
  screenRecording: boolean;
}

export interface ComputerPermissions {
  status(): ComputerPermissionStatus;
}

export interface ComputerControlPresentation {
  /** The agent, such as "Codex". */
  title: string;
  /** Such as "is using Safari". */
  detail: string;
}

/** The floating "Codex is using Safari · Stop · esc" bar. */
export interface ComputerControlPanel {
  show(presentation: ComputerControlPresentation): void;
  hide(): void;
  /** Run `work` with the bar's global Esc released, so an Escape the agent
   * sends is not taken as the user's Stop. */
  withoutEscape<T>(work: () => Promise<T>): Promise<T>;
}
