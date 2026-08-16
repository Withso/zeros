// ──────────────────────────────────────────────────────────
// Zeros Electron — IPC router
// ──────────────────────────────────────────────────────────
//
// The renderer calls `window.__ZEROS_NATIVE__.invoke("cmd_name", args)`,
// which the preload forwards to `ipcMain.handle("zeros:invoke", ...)`.
// This router dispatches the command name to the matching handler.
//
// `commandTable` below is the single source of truth for what the renderer may
// ask the main process to do: one entry per command name, and an UNKNOWN name
// throws rather than resolving `undefined` — a silent undefined is
// indistinguishable from "the handler returned nothing", which is exactly how
// a typo'd command name hides for days.
//
// Entries start life as `notImpl(...)` placeholders and are replaced in-place
// by `registerCommand` as each handler is wired, so the table doubles as an
// at-a-glance inventory of the entire native surface.
// ──────────────────────────────────────────────────────────

import { ipcMain, type IpcMainInvokeEvent } from "electron";

export const IPC_INVOKE_CHANNEL = "zeros:invoke";

/** Handler signature — receives parsed args object, returns a value
 *  (or promise) that the renderer awaits. Throw to propagate an error
 *  back to the renderer's awaited `invoke()`. */
export type CommandHandler = (
  args: Record<string, unknown>,
  event: IpcMainInvokeEvent,
) => unknown | Promise<unknown>;

/** Placeholder entry: throws a clear "not wired" error back to the renderer
 *  instead of resolving `undefined`, so an un-implemented command fails loudly
 *  at the call site. The second argument is a bookkeeping ordinal kept beside
 *  each table entry; it is never shown to the user. */
function notImpl(cmd: string, _order: number): CommandHandler {
  return () => {
    throw new Error(
      `[Zeros] IPC command "${cmd}" is not available in this build.`,
    );
  };
}

/** The full command table. Keep this list in sync — a missing entry
 *  means a React call site throws "unknown command" in Electron.
 */
const commandTable: Record<string, CommandHandler> = {
  // ── App info (runtime mode / version) — for analytics routing ──
  app_info: notImpl("app_info", 1),

  // ── App settings (plain-JSON, main-readable) + engine restart ──
  app_setting_get: notImpl("app_setting_get", 1),
  app_setting_set: notImpl("app_setting_set", 1),
  engine_restart: notImpl("engine_restart", 1),

  // ── Sidecar / engine lifecycle ────────────────────────────
  get_engine_port: notImpl("get_engine_port", 2),
  get_engine_token: notImpl("get_engine_token", 2),
  get_engine_root: notImpl("get_engine_root", 2),
  open_project_folder: notImpl("open_project_folder", 2),
  open_project_folder_path: notImpl("open_project_folder_path", 2),
  pick_project_folder: notImpl("pick_project_folder", 2),
  engine_reset_to_default: notImpl("engine_reset_to_default", 2),

  // ── Shell / system ────────────────────────────────────────
  shell_open_url: notImpl("shell_open_url", 3),
  reveal_in_finder: notImpl("reveal_in_finder", 3),
  open_in_terminal: notImpl("open_in_terminal", 3),
  open_agent_config: notImpl("open_agent_config", 3),
  open_install_terminal: notImpl("open_install_terminal", 3),
  detect_open_apps: notImpl("detect_open_apps", 3),
  open_in_app: notImpl("open_in_app", 3),

  // ── Auth0 session @ rest — main owns the full token pair; the renderer only
  // ever gets a live access token or decoded identity claims. The pair is written
  // to the keychain by auth_redeem_handoff itself (no renderer-reachable install
  // command), so an XSS can't plant forged tokens. See
  // apps/desktop/electron/ipc/commands/auth-session.ts. (legacy auth_storage_*/
  // auth_open_signin/get_session/sign_out removed across the 2026-06 and
  // 2026-07 auth rebuilds.)
  auth_get_access_token: notImpl("auth_get_access_token", 5),
  auth_get_session_user: notImpl("auth_get_session_user", 5),
  auth_clear_session: notImpl("auth_clear_session", 5),
  auth_sign_out_everywhere: notImpl("auth_sign_out_everywhere", 5),

  // ── Web sign-in handoff — the website owns OAuth; the desktop redeems an
  // opaque single-use ticket for a session. Verifier stays in main safeStorage.
  // See apps/desktop/electron/ipc/commands/auth-handoff.ts.
  auth_begin_handoff: notImpl("auth_begin_handoff", 5),
  auth_redeem_handoff: notImpl("auth_redeem_handoff", 5),
  // Nonce-only peek so a sibling dev worktree can complete a handoff another
  // instance began (single shared zeros-dev:// scheme). Never returns the verifier.
  auth_peek_handoff: notImpl("auth_peek_handoff", 5),

  // ── Keychain / CSS / skills / localhost ────────────
  keychain_set: notImpl("keychain_set", 5),
  keychain_get: notImpl("keychain_get", 5),
  keychain_has: notImpl("keychain_has", 5),
  keychain_delete: notImpl("keychain_delete", 5),
  agent_context_files: notImpl("agent_context_files", 9),
  agent_memory_files: notImpl("agent_memory_files", 9),
  pick_css_file: notImpl("pick_css_file", 5),
  read_css_file: notImpl("read_css_file", 5),
  write_css_file: notImpl("write_css_file", 5),
  read_file: notImpl("read_file", 5),
  read_image_thumbnail: notImpl("read_image_thumbnail", 5),
  write_file: notImpl("write_file", 5),
  skills_list: notImpl("skills_list", 5),
  discover_localhost_services: notImpl("discover_localhost_services", 5),

  // ── Structured app logs (feedback / debugging) ────────────
  // Renderer console batches in; scrubbed recent tail out (feedback
  // attachment) or exported to a temp .jsonl and opened (View button).
  log_submit: notImpl("log_submit", 0),
  logs_recent: notImpl("logs_recent", 0),
  logs_export_open: notImpl("logs_export_open", 0),

  // ── Notifications / updater / process ─────────────────────
  notify_send: notImpl("notify_send", 8),
  process_metrics_snapshot: notImpl("process_metrics_snapshot", 8),
  updater_check: notImpl("updater_check", 8),
  updater_install: notImpl("updater_install", 8),
  updater_status: notImpl("updater_status", 8),
  process_relaunch: notImpl("process_relaunch", 8),

  // ── Agent attachment staging and context graph ───────────────
  // Moves base64 attachment bytes into the workspace's .context-graph.
  // A file-write, not chat storage. Write-only: the graph is append-only
  // from the app (files leave it only via the user deleting them on disk).
  agent_attachment_write: notImpl("agent_attachment_write", 8),
  design_export_png: notImpl("design_export_png", 8),

  // Agent transcript and chat-list channels were removed — that storage
  // moved to the engine's Zeros DB (reached over the bridge).

  // ── Iframe browser ────────────────────────────────────────
  "iframe:clear-cache": notImpl("iframe:clear-cache", 0),
  "iframe:clear-cookies": notImpl("iframe:clear-cookies", 0),
  "iframe-picker:capture-region": notImpl("iframe-picker:capture-region", 0),
  "browser:reinject-picker": notImpl("browser:reinject-picker", 0),
  "browser:control-iframe": notImpl("browser:control-iframe", 0),
  browser_confirmation_respond: notImpl("browser_confirmation_respond", 0),
  browser_confirmation_requests: notImpl("browser_confirmation_requests", 0),
  browser_session_attach: notImpl("browser_session_attach", 0),
  browser_session_capture: notImpl("browser_session_capture", 0),
  browser_session_close: notImpl("browser_session_close", 0),
  browser_session_park: notImpl("browser_session_park", 0),
  browser_session_states: notImpl("browser_session_states", 0),
  browser_session_detach: notImpl("browser_session_detach", 0),
  browser_session_control: notImpl("browser_session_control", 0),
  browser_session_stop: notImpl("browser_session_stop", 0),
  browser_ui_preferences_update: notImpl("browser_ui_preferences_update", 0),

  // ── Workspace lifecycle ──────────────────────────────────
  // (lifecycle list/create/archive/etc. moved to the engine bridge; only the
  //  repo-bootstrap + folder-inspect commands run on this IPC channel.)
  workspace_init_repo: notImpl("workspace_init_repo", 3.7),
  workspace_clone: notImpl("workspace_clone", 3.7),
  workspace_inspect_folder: notImpl("workspace_inspect_folder", 3.7),
  dialog_pick_folder: notImpl("dialog_pick_folder", 3.7),
  // The only git handler that stays in main after the single-writer migration —
  // DB-FREE (lists files in a cwd via `git ls-files`, no workspace lookup). All
  // other git ops moved onto the engine bridge.
  git_list_files: notImpl("git_list_files", 3.7),

  // ── GitHub auth surfaces ──────────────────────────────────
  // (git read/write ops + PR create/list/review all moved to the engine
  //  bridge; only the GitHub-auth commands run on this IPC channel.)
  gh_auth_snapshot: notImpl("gh_auth_snapshot", 3.7),
  gh_app_cancel: notImpl("gh_app_cancel", 3.7),
  gh_app_connect: notImpl("gh_app_connect", 3.7),
  gh_method_select: notImpl("gh_method_select", 3.7),
  gh_pat_connect: notImpl("gh_pat_connect", 3.7),
  gh_pat_restore: notImpl("gh_pat_restore", 3.7),
  gh_method_disconnect: notImpl("gh_method_disconnect", 3.7),
  gh_credential_clear: notImpl("gh_credential_clear", 3.7),

  // ── Custom window chrome (drag + zoom via JS, not CSS drag region) ─
  // See apps/desktop/electron/ipc/commands/window.ts for the rationale (macOS
  // -webkit-app-region: drag swallows clicks, blocking popover
  // dismissal — we own drag in JS instead).
  window_drag_start: notImpl("window_drag_start", 0),
  window_drag_end: notImpl("window_drag_end", 0),
  window_zoom_toggle: notImpl("window_zoom_toggle", 0),
  // Theme plumbing (registered in commands/command-registry.ts): the renderer reports the
  // resolved --bg1 hex + theme mode so the native window chrome matches. They
  // were registered via setCommand without a table entry, which warned
  // "registering new command not in table" on every launch (see the packaged
  // app's main.log) — harmless, but noise that looks like a bug in the field.
  window_set_background: notImpl("window_set_background", 0),
  appearance_set_mode: notImpl("appearance_set_mode", 0),
};

export function listCommandNames(): string[] {
  return Object.keys(commandTable).sort();
}

/** Called from main.ts after app.whenReady. Idempotent — re-registering
 *  removes the previous handler first. */
export function registerIpcHandlers(): void {
  ipcMain.removeHandler(IPC_INVOKE_CHANNEL);
  ipcMain.handle(IPC_INVOKE_CHANNEL, async (event, raw: unknown) => {
    if (!raw || typeof raw !== "object") {
      throw new Error("[Zeros] IPC: payload must be an object");
    }
    const { cmd, args } = raw as {
      cmd?: string;
      args?: Record<string, unknown>;
    };
    if (!cmd || typeof cmd !== "string") {
      throw new Error("[Zeros] IPC: missing 'cmd' string");
    }
    const handler = commandTable[cmd];
    if (!handler) {
      throw new Error(
        `[Zeros] IPC: unknown command "${cmd}". Expected one of ${
          Object.keys(commandTable).length
        } registered commands.`,
      );
    }
    return await handler(args ?? {}, event);
  });
}

/** Replace a single command's handler. Used by later phases to light up
 *  commands one at a time without touching the table above. */
export function setCommand(cmd: string, handler: CommandHandler): void {
  if (!(cmd in commandTable)) {
    // Allow new commands to be added, but warn
    // on unexpected names so typos don't silently succeed.
    console.warn(`[Zeros] registering new command not in table: ${cmd}`);
  }
  commandTable[cmd] = handler;
}
