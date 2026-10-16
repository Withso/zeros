import type { BrowserAppearance } from "@zeros/protocol/browser-tools";

/** The part of Electron's `webContents.debugger` this module uses. Electron
 * gives each page one CDP session, shared with Codex's built-in browser and
 * file uploads; whichever owner detaches ends it for everyone. */
export interface BrowserAppearanceDebugger {
  isAttached(): boolean;
  attach(protocolVersion?: string): void;
  sendCommand(method: string, params?: object): Promise<unknown>;
  on(event: "detach", listener: () => void): unknown;
  off(event: "detach", listener: () => void): unknown;
}

export interface BrowserAppearanceController {
  readonly appearance: BrowserAppearance | null;
  /** Resolves false when the page rejected the change; it never throws. */
  set(appearance: BrowserAppearance | null): Promise<boolean>;
  dispose(): void;
}

/** `null` clears the override so the page follows Zeros' nativeTheme. */
export function browserAppearanceMediaParams(
  appearance: BrowserAppearance | null,
): { media: ""; features: Array<{ name: string; value: string }> } {
  return {
    media: "",
    features: appearance
      ? [{ name: "prefers-color-scheme", value: appearance }]
      : [],
  };
}

/** Emulates one agent page's color scheme. Chromium keeps the override across
 * navigations only while the CDP session stays attached, so a detach by any
 * owner (Codex releases its debugger after every turn) reattaches and
 * reapplies. Clearing never detaches: another owner may be mid-command. */
export function createBrowserAppearanceController(target: {
  debugger: BrowserAppearanceDebugger;
  isAlive(): boolean;
  schedule?: (task: () => void) => void;
}): BrowserAppearanceController {
  const debug = target.debugger;
  const schedule = target.schedule ?? ((task) => setImmediate(task));
  let appearance: BrowserAppearance | null = null;
  let applied = true;
  let disposed = false;

  const apply = async (): Promise<boolean> => {
    if (disposed || !target.isAlive()) return false;
    const requested = appearance;
    if (!requested && !debug.isAttached()) return (applied = true);
    try {
      if (!debug.isAttached()) debug.attach("1.3");
      await debug.sendCommand(
        "Emulation.setEmulatedMedia",
        browserAppearanceMediaParams(requested),
      );
      if (requested === appearance) applied = true;
      return true;
    } catch {
      if (requested === appearance) applied = false;
      return false;
    }
  };
  const reapplyAfterDetach = () => {
    if (disposed || !appearance) return;
    // `detach` fires inside the other owner's own teardown; let it finish.
    schedule(() => void apply());
  };
  debug.on("detach", reapplyAfterDetach);

  return {
    get appearance() {
      return appearance;
    },
    set(next) {
      if (disposed) return Promise.resolve(false);
      // A repeat retries only a change the page has not accepted yet.
      if (next === appearance && applied) return Promise.resolve(true);
      appearance = next;
      return apply();
    },
    dispose() {
      disposed = true;
      debug.off("detach", reapplyAfterDetach);
    },
  };
}
