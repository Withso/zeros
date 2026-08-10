import type { BrowserWindow } from "electron";

import type {
  BrowserAutomationServerHandle,
  BrowserSessionBounds,
  BrowserSessionState,
} from "./browser-automation";

type BrowserSessionHost = Pick<
  BrowserAutomationServerHandle,
  "attach" | "control"
>;

/** Attach an existing process-local browser lease or recreate it from the
 * persisted tab URL after an application restart. */
export async function attachOrRestoreBrowserSession(
  host: BrowserSessionHost,
  taskId: string,
  target: BrowserWindow,
  bounds: BrowserSessionBounds,
  restoreUrl: string,
): Promise<BrowserSessionState | null> {
  const attached = host.attach(taskId, target, bounds);
  if (attached || !restoreUrl) return attached;

  const restored = await host.control(taskId, "open", {
    url: restoreUrl,
    width: bounds.width,
    height: bounds.height,
  });
  if (!restored.success) {
    const detail = restored.contentItems?.find(
      (item) => item.type === "inputText",
    );
    throw new Error(
      detail?.type === "inputText" && detail.text
        ? detail.text
        : "The browser page could not be restored.",
    );
  }
  return host.attach(taskId, target, bounds);
}
