// ──────────────────────────────────────────────────────────
// Zeros Electron — preload bridge
// ──────────────────────────────────────────────────────────
//
// Exposes `window.__ZEROS_NATIVE__` to the renderer via contextBridge.
// The API keeps the old native `invoke()` + `listen()` shape so the React
// facade in src/native/runtime.ts can use one call surface.
//
// Channel conventions:
//   zeros:invoke   — renderer → main request/response (ipcRenderer.invoke)
//   zeros:event    — main → renderer fan-out ({name, payload} envelope)
// ──────────────────────────────────────────────────────────

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

const INVOKE_CHANNEL = "zeros:invoke";
const EVENT_CHANNEL = "zeros:event";

// H1: the bridge used to forward ANY command string to main's full command
// table, so a single renderer XSS could reach every privileged command (token
// theft, fs, shell). We now allowlist exactly the commands the renderer
// actually invokes — derived from every `nativeInvoke(...)` / `.invoke(...)`
// call site in src/. A command not on this list is rejected here, before it
// reaches main, shrinking the XSS-reachable surface from ~115 commands to these.
//
// Maintenance: when the renderer starts calling a NEW main command, add it here
// (otherwise the call throws "command not permitted"). Git-write / PR / detach /
// chat-persistence ops are deliberately ABSENT — they run on the engine bridge,
// not this IPC channel, so they must never be reachable from page script here.
// `scripts/check-preload-allowlist.mjs` (pnpm check:preload) enforces that this
// set matches the commands actually invoked under src/, so it can't drift — a
// missing entry silently breaks a feature; a stale one widens the XSS surface.
const ALLOWED_COMMANDS = new Set<string>([
  "agent_attachment_write",
  "appearance_set_mode",
  "agent_context_files",
  "app_info",
  "auth_begin_handoff",
  "auth_clear_session",
  "auth_get_access_token",
  "auth_get_session_user",
  "auth_peek_handoff",
  "auth_redeem_handoff",
  "auth_sign_out_everywhere",
  "detect_open_apps",
  "dialog_pick_folder",
  "engine_reset_to_default",
  "get_engine_port",
  "get_engine_root",
  "get_engine_token",
  "gh_auth_snapshot",
  "gh_app_cancel",
  "gh_app_connect",
  "gh_method_select",
  "gh_pat_connect",
  "gh_pat_restore",
  "gh_method_disconnect",
  "gh_credential_clear",
  "git_list_files",
  "keychain_delete",
  "keychain_get",
  "keychain_has",
  "keychain_set",
  "log_submit",
  "logs_export_open",
  "logs_recent",
  "notify_send",
  "open_agent_config",
  "open_in_app",
  "open_in_terminal",
  "open_install_terminal",
  "pick_project_folder",
  "read_file",
  "write_file",
  "reveal_in_finder",
  "shell_open_url",
  "skills_list",
  "updater_check",
  "updater_install",
  "updater_status",
  "window_drag_end",
  "window_drag_start",
  "window_set_background",
  "window_zoom_toggle",
  "workspace_clone",
  "workspace_init_repo",
  "workspace_inspect_folder",
  // Browser-tab + design-mode picker IPC (Roadmap 03b) — colon-namespaced
  // channels invoked from src/zeros/browser/use-iframe-webview.ts. Omitting
  // these rejects cache/cookie clear, element screenshots, and picker
  // reinjection at the preload bridge (the bug this guard now prevents).
  "browser:reinject-picker",
  "iframe-picker:capture-region",
  "iframe:clear-cache",
  "iframe:clear-cookies",
]);

interface ZerosEventEnvelope {
  name: string;
  payload: unknown;
}

/** Subscribers keyed by event name. Each entry is a Set of handlers so
 *  duplicate subscribes deliver once per handler (matches the legacy
 *  native `listen()` behavior — each subscription is independent). */
const subscribers = new Map<string, Set<(payload: unknown) => void>>();

// ONE ipcRenderer listener fans out to name-specific subscribers. We
// never remove this (lifetime = preload), so no leaks; individual
// handlers are removed from the Sets when callers unsubscribe.
ipcRenderer.on(
  EVENT_CHANNEL,
  (_event: IpcRendererEvent, envelope: ZerosEventEnvelope) => {
    if (!envelope || typeof envelope.name !== "string") return;
    const set = subscribers.get(envelope.name);
    if (!set) return;
    for (const handler of set) {
      try {
        handler(envelope.payload);
      } catch (err) {
        // A bad subscriber shouldn't kill the fan-out.
        console.error(
          `[Zeros] event handler threw for "${envelope.name}":`,
          err,
        );
      }
    }
  },
);

const bridge = {
  /** Call a main-process command. Args is passed through as the single
   *  object payload the handler receives (mirrors the native invoke shape).
   *  H1: only allowlisted commands are forwarded — anything else is rejected
   *  here so a renderer XSS can't reach the full privileged command table. */
  invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    if (typeof cmd !== "string" || !ALLOWED_COMMANDS.has(cmd)) {
      return Promise.reject(
        new Error(`[Zeros] command not permitted: "${cmd}"`),
      );
    }
    return ipcRenderer.invoke(INVOKE_CHANNEL, { cmd, args });
  },

  /** Subscribe to a named event. Returns an unsubscribe function. */
  on<T = unknown>(
    eventName: string,
    handler: (payload: T) => void,
  ): () => void {
    let set = subscribers.get(eventName);
    if (!set) {
      set = new Set();
      subscribers.set(eventName, set);
    }
    const wrapped = (p: unknown) => handler(p as T);
    set.add(wrapped);
    return () => {
      set!.delete(wrapped);
      if (set!.size === 0) subscribers.delete(eventName);
    };
  },
};

contextBridge.exposeInMainWorld("__ZEROS_NATIVE__", bridge);

// Durable appearance-mode fallback (see window.ts appearance section).
// main passes the userData-persisted theme mode via additionalArguments;
// exposing it here (preloads run before ANY page script, including the
// index.html pre-paint stamp) lets the stamp + the appearance store
// recover the right theme when localStorage was purged (it lives in the
// OS-purgeable Caches dir). Sandboxed preloads still get process.argv.
const appearanceArg = process.argv.find((a) =>
  a.startsWith("--zeros-appearance-mode="),
);
const appearanceMode = appearanceArg?.split("=")[1];
if (
  appearanceMode === "system" ||
  appearanceMode === "light" ||
  appearanceMode === "dark"
) {
  contextBridge.exposeInMainWorld("__ZEROS_APPEARANCE_MODE__", appearanceMode);
}

console.log("[Zeros] preload: __ZEROS_NATIVE__ exposed on window");
