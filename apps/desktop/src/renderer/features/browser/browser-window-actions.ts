import { isCloudWorkspace } from "../../platform/bridge/cloud-workspace-key";
import { nativeInvoke } from "../../platform/runtime";
import { isLoopbackUrl } from "../../shell/workbench/tabs/localhost-url";

/** Mirrors `BrowserPreviewWindowResult` in apps/desktop/electron/browser-preview-window.ts. */
type NativeOpenWindowResult =
  | { ok: true; reused: boolean }
  | {
      ok: false;
      reason:
        | "invalid-request"
        | "unsupported-url"
        | "cloud-preview-unsupported"
        | "too-many-windows"
        | "unauthorized"
        | "unavailable";
    };

export type OpenBrowserWindowResult =
  | { ok: true; reused: boolean }
  | { ok: false; reason: string; message: string };

export interface BrowserWindowAvailabilityInput {
  /** Persisted workbench scope of the tab (a `cloud://…` key for cloud workspaces). */
  scope?: string;
  /** The tab's logical URL, as shown in the address bar. */
  url: string;
  /** The tab shows an agent preview listener (`tab.previewSource`). */
  agentPreview?: boolean;
  /** The iframe currently renders a volatile preview origin for the logical URL. */
  previewRuntimeActive?: boolean;
}

export const BROWSER_WINDOW_PREVIEW_UNSUPPORTED =
  "Not available for workspace previews yet";

/** Tooltip text when the tab cannot open in its own window, or null when it can.
 * Workspace previews load an origin admitted only for the tab's iframe; the
 * logical localhost URL would reach this Mac's server instead of the preview. */
export function browserWindowUnavailableReason(
  input: BrowserWindowAvailabilityInput,
): string | null {
  if (!/^https?:\/\//i.test(input.url)) return "Open a web page first";
  if (input.agentPreview || input.previewRuntimeActive) {
    return BROWSER_WINDOW_PREVIEW_UNSUPPORTED;
  }
  if (isCloudWorkspace(input.scope ?? "") && isLoopbackUrl(input.url)) {
    return BROWSER_WINDOW_PREVIEW_UNSUPPORTED;
  }
  return null;
}

const FAILURE_MESSAGES: Record<string, string> = {
  "invalid-request": "Couldn't open this page in a new window.",
  "unsupported-url": "Only web pages (http or https) can open in a new window.",
  "cloud-preview-unsupported":
    "Workspace previews can't open in a separate window yet.",
  "too-many-windows": "Close a preview window before opening another.",
  unauthorized: "Couldn't open this page in a new window.",
  unavailable: "Couldn't open this page in a new window.",
};

function failure(reason: string): OpenBrowserWindowResult {
  return {
    ok: false,
    reason,
    message:
      FAILURE_MESSAGES[reason] ?? "Couldn't open this page in a new window.",
  };
}

/** Open the Browser tab's page in its own preview window. Never throws;
 * failures carry a toast-ready message. */
export async function openBrowserWindow(
  input: BrowserWindowAvailabilityInput & {
    /** The tab's iframe name, `zeros-browser-<tabId>`; keys window reuse. */
    frameName: string;
    title?: string;
  },
): Promise<OpenBrowserWindowResult> {
  if (browserWindowUnavailableReason(input) !== null) {
    return failure(
      /^https?:\/\//i.test(input.url)
        ? "cloud-preview-unsupported"
        : "unsupported-url",
    );
  }
  try {
    const result = await nativeInvoke<NativeOpenWindowResult>(
      "browser:open-window",
      {
        key: input.frameName,
        url: input.url,
        ...(input.scope ? { scope: input.scope } : {}),
        ...(input.title ? { title: input.title } : {}),
      },
    );
    if (result?.ok === true) return { ok: true, reused: result.reused };
    return failure(result?.ok === false ? result.reason : "unavailable");
  } catch {
    return failure("unavailable");
  }
}

/** Mirrors `BrowserFrameDevToolsResult` in apps/desktop/electron/browser-frame-devtools.ts. */
type NativeInspectFrameResult =
  | { ok: true }
  | { ok: false; reason: "invalid-request" | "unauthorized" | "unavailable" };

export type InspectBrowserFrameResult =
  | { ok: true }
  | { ok: false; message: string };

const INSPECT_FAILURE: InspectBrowserFrameResult = {
  ok: false,
  message: "Couldn't open DevTools for this page.",
};

/** Tooltip text when DevTools has nothing to inspect, or null when it does.
 * DevTools inspects the tab's own iframe, so every placement and preview kind
 * qualifies once a web page is showing. */
export function browserDevToolsUnavailableReason(url: string): string | null {
  return /^https?:\/\//i.test(url) ? null : "Open a web page first";
}

/** The centre of the frame's on-screen part in viewport CSS px, or null when
 * none of it is visible. */
export function browserFrameInspectPoint(
  rect: Pick<DOMRectReadOnly, "left" | "top" | "right" | "bottom">,
  viewport: { width: number; height: number },
): { x: number; y: number } | null {
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(viewport.width, rect.right);
  const bottom = Math.min(viewport.height, rect.bottom);
  if (!(right - left >= 1 && bottom - top >= 1)) return null;
  return { x: Math.round((left + right) / 2), y: Math.round((top + bottom) / 2) };
}

/** Open DevTools on the Browser tab's own iframe: its page is selected in
 * Elements and the Console runs in it. No preview window opens. Never
 * throws; a failure carries a toast-ready message. */
export async function inspectBrowserFrame(input: {
  frameName: string;
  frame: Element | null;
}): Promise<InspectBrowserFrameResult> {
  const point = input.frame
    ? browserFrameInspectPoint(input.frame.getBoundingClientRect(), {
        width: window.innerWidth,
        height: window.innerHeight,
      })
    : null;
  try {
    const result = await nativeInvoke<NativeInspectFrameResult>(
      "browser:inspect-frame",
      { frameName: input.frameName, ...(point ?? {}) },
    );
    return result?.ok === true ? { ok: true } : INSPECT_FAILURE;
  } catch {
    return INSPECT_FAILURE;
  }
}
