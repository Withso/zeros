// ──────────────────────────────────────────────────────────
// MCP gateway — open a URL in the user's system browser (from the engine)
// ──────────────────────────────────────────────────────────
//
// The OAuth authorization step (RFC 8252) MUST use the EXTERNAL system browser,
// never an embedded webview. The engine runs under bun and can't call Electron's
// shell.openExternal directly, so it hands off to the OS opener. Detached +
// stdio-ignored + unref'd so it never blocks or dies with the engine.
// ──────────────────────────────────────────────────────────

import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { normalizeExternalHttpUrl } from "@zeros/protocol/external-url";

/** Open `url` in the default browser via the OS. Best-effort — a failure is
 *  logged, never thrown (the caller's auth flow surfaces the timeout instead). */
export function openExternalUrl(url: string): void {
  const normalized = normalizeExternalHttpUrl(url);
  if (!normalized) {
    console.warn("[mcp-gateway] refused invalid external browser URL");
    return;
  }
  const platform = process.platform;
  const [cmd, args]: [string, string[]] =
    platform === "darwin"
      ? ["open", [normalized]]
      : platform === "win32"
        // Quote the URL: cmd.exe re-parses its own command line, so an unquoted
        // `&` in the URL would be treated as a command separator (injection).
        ? ["cmd", ["/c", "start", "", `"${normalized}"`]]
        : ["xdg-open", [normalized]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    // Attach via EventEmitter (ChildProcess's inherited .on isn't seen by this
    // tsconfig — the same quirk the other host spawners tolerate). The listener
    // is required: an unhandled "error" (e.g. opener missing) would otherwise throw.
    (child as unknown as EventEmitter).on("error", (e: Error) =>
      console.warn(`[mcp-gateway] open browser failed: ${e.message}`),
    );
    child.unref();
  } catch (e) {
    console.warn(`[mcp-gateway] open browser failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
