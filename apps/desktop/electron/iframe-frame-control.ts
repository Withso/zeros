export type BrowserIframeControl =
  | { action: "back" }
  | { action: "forward" }
  | { action: "reload" }
  | { action: "navigate"; url: string };

export type BrowserIframeControlRequest =
  | ({ frameName: string } & Exclude<
      BrowserIframeControl,
      { action: "navigate" }
    >)
  | { frameName: string; action: "navigate"; url: string };

interface ControllableBrowserFrame {
  isDestroyed(): boolean;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  reload(): boolean;
}

const BROWSER_FRAME_NAME = /^zeros-browser-[A-Za-z0-9._:-]{1,300}$/;

/** Parse the privileged iframe-control boundary. The renderer can select only
 * one app-created Browser frame and one fixed action; it never supplies code. */
export function parseBrowserIframeControl(
  value: Record<string, unknown>,
): BrowserIframeControlRequest | null {
  const frameName = value.frameName;
  const action = value.action;
  if (
    typeof frameName !== "string" ||
    !BROWSER_FRAME_NAME.test(frameName) ||
    (action !== "back" &&
      action !== "forward" &&
      action !== "reload" &&
      action !== "navigate")
  ) {
    return null;
  }
  if (action !== "navigate") return { frameName, action };
  if (typeof value.url !== "string" || value.url.length > 8_192) return null;
  try {
    const url = new URL(value.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.username = "";
    url.password = "";
    return { frameName, action, url: url.href };
  } catch {
    return null;
  }
}

/** Dispatch a trusted user Browser-chrome action against Chromium's existing
 * nested browsing context. History traversal stays inside the live frame and
 * therefore preserves the browser's own page-state/history entries. */
export async function controlBrowserIframe(
  frame: ControllableBrowserFrame,
  control: BrowserIframeControl,
): Promise<boolean> {
  if (frame.isDestroyed()) return false;
  try {
    if (control.action === "reload") return frame.reload();
    const code =
      control.action === "back"
        ? "history.back()"
        : control.action === "forward"
          ? "history.forward()"
          : `location.assign(${JSON.stringify(control.url)})`;
    await frame.executeJavaScript(code, true);
    return true;
  } catch {
    return false;
  }
}
