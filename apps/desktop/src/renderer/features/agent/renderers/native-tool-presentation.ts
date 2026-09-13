import type { AgentToolMessage } from "../use-agent-session";
import { safeToolImageSource } from "@zeros/protocol/tool-artwork";

export function toolRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function nativeToolTitle(tool: AgentToolMessage): string | undefined {
  const input = toolRecord(tool.rawInput);
  if (
    tool.toolKind !== "mcp" ||
    !["node_repl", "cua_repl", "computer-use"].includes(String(input.server))
  )
    return;
  const title = toolRecord(input.arguments).title;
  return typeof title === "string" && title.trim()
    ? title.trim().replace(/\s+/g, " ").slice(0, 160)
    : undefined;
}

export interface NativeToolSurface {
  kind: "browser" | "computer";
  /** Provider-owned backend identity. Never substitute the local IAB's live
   * page when the call belongs to Chrome or another browser profile. */
  scope: string;
  external: boolean;
  appId?: string;
  url?: string;
  faviconUrl?: string;
}

const BROWSER_APP_IDS: Record<string, string> = {
  chrome: "com.google.Chrome",
  edge: "com.microsoft.edgemac",
  brave: "com.brave.Browser",
  opera: "com.operasoftware.Opera",
  vivaldi: "com.vivaldi.Vivaldi",
};

export function toolWebUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 8192) return;
  try {
    const url = new URL(value);
    if (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    )
      return url.href;
  } catch {
    /* malformed provider metadata has no artwork */
  }
}

/** Exact, bounded envelopes from app-server generations. Do not search tool
 * text recursively: a result may contain arbitrary documents or large images. */
export function nativeToolOutputMetadata(
  tool: AgentToolMessage,
): Record<string, unknown>[] {
  const output = toolRecord(tool.rawOutput);
  const result = toolRecord(output.result);
  return [output, result, toolRecord(output.raw), toolRecord(result.raw)].map(
    (value) => toolRecord(value._meta),
  );
}

export function nativeToolSurface(
  tool: AgentToolMessage,
): NativeToolSurface | null {
  const input = toolRecord(tool.rawInput);
  if (
    tool.toolKind !== "mcp" ||
    !["cua_repl", "node_repl", "computer-use"].includes(String(input.server))
  )
    return null;
  for (const meta of nativeToolOutputMetadata(tool)) {
    const surface = toolRecord(meta["codex/toolSurface"]);
    if (surface.kind === "computerUse") {
      const app = toolRecord(surface.app);
      const appId =
        ["appId", "mac"].includes(String(app.kind)) &&
        typeof app.appId === "string" &&
        /^[\w-]+(?:\.[\w-]+)+$/.test(app.appId) &&
        app.appId.length <= 255
          ? app.appId
          : undefined;
      return {
        kind: "computer",
        scope: `computer:${appId ?? "unknown"}`,
        external: true,
        ...(appId ? { appId } : {}),
      };
    }
    if (surface.kind === "browserUse") {
      const screenshot = toolRecord(surface.screenshot);
      const tabs = Array.isArray(surface.openTabs)
        ? surface.openTabs.slice(0, 100)
        : [];
      const tab =
        screenshot.tabId == null
          ? {}
          : toolRecord(
              tabs.find(
                (tab) =>
                  String(toolRecord(tab).id) === String(screenshot.tabId),
              ),
            );
      const url = toolWebUrl(screenshot.pageUrl) ?? toolWebUrl(tab.url);
      const faviconUrl =
        url && toolWebUrl(tab.url) === url
          ? safeToolImageSource(tab.faviconUrl)
          : undefined;
      // Only the legacy node_repl binding is known to be Zeros' live view.
      // CUA can select a different IAB/browser profile independently.
      const external = input.server === "cua_repl" || surface.backend !== "iab";
      const family =
        typeof surface.browserFamily === "string"
          ? surface.browserFamily
          : surface.backend;
      const appId =
        surface.backend !== "iab" ? BROWSER_APP_IDS[String(family)] : undefined;
      return {
        kind: "browser",
        external,
        scope: JSON.stringify(
          [
            surface.backend,
            surface.browserFamily,
            surface.browserId,
            surface.extensionInstanceId,
          ].map((value) =>
            typeof value === "string" ? value.slice(0, 256) : null,
          ),
        ),
        ...(appId ? { appId } : {}),
        ...(url ? { url } : {}),
        ...(faviconUrl ? { faviconUrl } : {}),
      };
    }
  }
  return null;
}
