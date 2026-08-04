// ──────────────────────────────────────────────────────────
// Phase-by-phase command registration
// ──────────────────────────────────────────────────────────
//
// Each phase adds a block here that calls `setCommand(...)` for the
// commands it lights up. The router's initial table registers every
// command as `notImpl`; this file replaces entries with real handlers
// as they come online. Keeps the "what's ready vs stubbed" question
// one-file-away from any caller.
// ──────────────────────────────────────────────────────────

import { setCommand } from "../router";
import {
  dialogPickFolder,
  engineResetToDefault,
  getEnginePort,
  getEngineToken,
  getEngineRoot,
  openProjectFolder,
  openProjectFolderPath,
  pickProjectFolder,
} from "./sidecar";
import {
  openAgentConfig,
  openInstallTerminal,
  openInTerminal,
  revealInFinder,
  shellOpenUrl,
} from "./shell";
import { detectOpenApps, openInApp } from "./open-apps";
import {
  keychainDelete,
  keychainGet,
  keychainHas,
  keychainSet,
} from "./secrets";
import {
  authBeginHandoff,
  authPeekHandoff,
  authRedeemHandoff,
} from "./auth-handoff";
import {
  authClearSession,
  authGetAccessToken,
  authGetSessionUser,
  authSignOutEverywhere,
} from "./auth-session";
import { agentContextFiles } from "./agent-context";
import { agentMemoryFiles } from "./agent-memory";
import { pickCssFile, readCssFile, writeCssFile } from "./css-files";
import { readFile, readImageThumbnail, writeFile } from "./files";
import { skillsList } from "./skills";
import { discoverLocalhostServices } from "./localhost";
import { notifySend } from "./notifications";
import { processMetricsSnapshot } from "./process-metrics";
import { agentAttachmentWrite } from "./agent-attachments";
import {
  processRelaunch,
  updaterCheck,
  updaterInstall,
  updaterStatus,
} from "../../updater";
// Single-writer migration: the DB-touching git/workspace IPC handlers were
// MOVED onto the engine bridge (src/native/git.ts now routes them through the
// RuntimeClient → workspace/service.ts handle()), so they're no longer
// registered here — Electron main can no longer open zeros.db. Only the
// DB-FREE handlers remain (file listing by cwd + repo init/clone/inspect on the
// host filesystem). The invariant this protects: exactly ONE process ever
// writes zeros.db, so two writers can never race on the same SQLite file.
import {
  gitListFiles,
  workspaceClone,
  workspaceInitRepo,
  workspaceInspectFolder,
} from "./git";
// GitHub PR ops moved onto the engine bridge (single-writer). Only the AUTH ops
// (safeStorage-only, never the DB) + the token courier stay in Electron main.
import {
  ghAppCancel,
  ghAppConnect,
  ghAuthSnapshot,
  ghCredentialClear,
  ghMethodDisconnect,
  ghMethodSelect,
  ghPatConnect,
  ghPatRestore,
  withNativeErrors,
} from "./github";
// Detach-mode IPC removed (dead — zero renderer callers; its detach_state access
// was the last DB-touching path in main). Engine impl stays for a future re-wire.
import {
  appearanceSetMode,
  windowDragEnd,
  windowDragStart,
  windowSetBackground,
  windowZoomToggle,
} from "./window";
import { appInfo, appSettingGet, appSettingSet, engineRestart } from "./app";
import { logSubmit, logsExportOpen, logsRecent } from "./logs";
export function registerAllCommands(): void {
  // App info (runtime mode / version / platform) — consumed by the
  // renderer analytics layer to route events to the right PostHog
  // project (Zeros Dev vs Zeros). Metadata only.
  setCommand("app_info", appInfo);

  // App settings (plain-JSON, main-process readable) + in-place engine
  // restart. These settings persist to <userData>/app-settings.json so
  // spawnEngine can read them before launching the engine child; engine_restart
  // respawns the engine so startup-only runtime settings apply without a full
  // app relaunch.
  // Structured app logs — renderer console forwarding + the feedback form's
  // scrubbed log tail ("Include recent app logs" / View). See commands/logs.ts.
  setCommand("log_submit", logSubmit);
  setCommand("logs_recent", logsRecent);
  setCommand("logs_export_open", logsExportOpen);

  setCommand("app_setting_get", appSettingGet);
  setCommand("app_setting_set", appSettingSet);
  setCommand("engine_restart", engineRestart);

  // Phase 2 — sidecar + project folder
  setCommand("get_engine_port", getEnginePort);
  setCommand("get_engine_token", getEngineToken);
  setCommand("get_engine_root", getEngineRoot);
  setCommand("open_project_folder", openProjectFolder);
  setCommand("open_project_folder_path", openProjectFolderPath);
  setCommand("pick_project_folder", pickProjectFolder);
  setCommand("engine_reset_to_default", engineResetToDefault);

  // Phase 3 — shell helpers
  setCommand("shell_open_url", shellOpenUrl);
  setCommand("reveal_in_finder", revealInFinder);
  setCommand("open_in_terminal", openInTerminal);
  setCommand("open_agent_config", openAgentConfig);
  setCommand("open_install_terminal", openInstallTerminal);
  // Topbar "Open in…" — installed-IDE probe (+ real app icons) and the
  // open-a-worktree-in-a-detected-IDE launcher. See commands/open-apps.ts.
  setCommand("detect_open_apps", detectOpenApps);
  setCommand("open_in_app", openInApp);

  // Phase 5 — auth (browser sign-in flow via app.zeros.build/auth.zeros.build)
  // Auth0 session @ rest — main owns the full token pair (auth-session.ts); the
  // renderer only ever gets a live access token or decoded identity claims, NEVER
  // the refresh token. The token pair is written straight to the keychain by
  // auth_redeem_handoff (persistSession) — there is deliberately NO renderer
  // "install session" command, so a renderer XSS can't plant forged tokens. (The
  // legacy auth_storage_* Supabase-storage-adapter commands, and the older
  // auth_open_signin/auth_get_session/auth_sign_out commands before that, were
  // both removed in the Auth0 migration.)
  setCommand("auth_get_access_token", authGetAccessToken);
  setCommand("auth_get_session_user", authGetSessionUser);
  setCommand("auth_clear_session", authClearSession);
  setCommand("auth_sign_out_everywhere", authSignOutEverywhere);

  // Web sign-in handoff: begin (mint verifier → return its S256 challenge) +
  // redeem (opaque ticket → independent Auth0 token pair + identity claims). The
  // verifier never leaves the main process; redeem persists the token pair into
  // the keychain itself and returns only the access token + identity claims.
  setCommand("auth_begin_handoff", authBeginHandoff);
  setCommand("auth_redeem_handoff", authRedeemHandoff);
  // Lets whichever instance the OS hands the zeros-dev:// callback to recognise a
  // handoff a SIBLING worktree started; verifier stays main-only (peek = nonce).
  setCommand("auth_peek_handoff", authPeekHandoff);

  // Phase 5 — keychain / css / skills / localhost
  setCommand("keychain_set", keychainSet);
  setCommand("keychain_get", keychainGet);
  setCommand("keychain_has", keychainHas);
  setCommand("keychain_delete", keychainDelete);
  setCommand("agent_context_files", agentContextFiles);
  setCommand("agent_memory_files", agentMemoryFiles);
  setCommand("pick_css_file", pickCssFile);
  setCommand("read_css_file", readCssFile);
  setCommand("write_css_file", writeCssFile);
  setCommand("read_file", readFile);
  setCommand("read_image_thumbnail", readImageThumbnail);
  setCommand("write_file", writeFile);
  setCommand("skills_list", skillsList);
  setCommand("discover_localhost_services", discoverLocalhostServices);

  // Phase 8 — notifications, updater, process
  setCommand("notify_send", notifySend);
  setCommand("process_metrics_snapshot", processMetricsSnapshot);
  setCommand("updater_check", updaterCheck);
  setCommand("updater_install", updaterInstall);
  setCommand("updater_status", updaterStatus);
  setCommand("process_relaunch", processRelaunch);

  // (Phase 2c) Agent transcript + chat-list persistence moved to the engine's
  // unified Zeros DB (reached over the bridge); the electron/db.ts handlers are
  // gone. Image attachments stay here — a file-write, unrelated to chat storage.
  //
  // Native startup fallback for the engine bridge's attachment writer. Normal
  // sends use attachment.write so desktop and relay clients share one protocol.
  setCommand("agent_attachment_write", agentAttachmentWrite);

  // Roadmap 03a — Git + GitHub integration layer, phase 1: workspace
  // lifecycle. Engine logic lives in src/engine/git/; these handlers
  // are thin pass-throughs.
  // workspace lifecycle (create/list/get/archive/restore/delete) moved to the
  // engine bridge (single-writer) — they all resolve a workspace from zeros.db.

  // ── UI-WIRING STATUS (audit 2026-05-31, scope: write-UI deferred) ──
  // The git/PR commands below are fully implemented + IPC-registered, but
  // most have NO renderer UI yet — they're "engine-only / pending UI". The
  // Changes/Diff write tab that would call them is a separate, later effort
  // (deliberately deferred). Don't read "registered" as "reachable from the
  // app". Currently renderer-wired: git_rename_branch (topbar rename),
  // gh_pr_list (composer #-PR picker), gh_auth_*, the workspace_* lifecycle
  // + propose_branch_name + create_from_branch, and detach_*. Engine-only
  // until the write-UI lands: git_status/list_files/diff/log/list_branches,
  // git_checkout/create_branch_from/stage/unstage/commit/push/pull/rebase/
  // stash_save/stash_pop/fetch/change_target_branch, and gh_pr_create/update/
  // mark_ready/get/merge (~22 commands).
  //
  // Roadmap 03a — phase 2: git operations. Read paths
  // (status / diff / log / list-branches) use isomorphic-git; write
  // paths (commit / push / pull / rebase / stash / fetch / stage /
  // checkout / rename) shell out to system git.
  // Single-writer: all DB-touching git ops now run on the engine over the bridge
  // (src/native/git.ts → workspace/service.ts handle()). The only git handler
  // that stays in main is git_list_files — DB-FREE (lists files in a cwd via
  // `git ls-files`, no workspace lookup).
  setCommand("git_list_files", gitListFiles);

  // GitHub auth is method-addressed and main-owned. Every response is
  // secret-free; selected credentials reach the engine over private stdin.
  // withNativeErrors keeps each failure's code + remediation intact across IPC,
  // which Electron would otherwise flatten into one prefixed string.
  setCommand("gh_auth_snapshot", withNativeErrors(ghAuthSnapshot));
  setCommand("gh_app_cancel", ghAppCancel);
  setCommand("gh_app_connect", withNativeErrors(ghAppConnect));
  setCommand("gh_method_select", withNativeErrors(ghMethodSelect));
  setCommand("gh_pat_connect", withNativeErrors(ghPatConnect));
  setCommand("gh_pat_restore", withNativeErrors(ghPatRestore));
  setCommand("gh_method_disconnect", withNativeErrors(ghMethodDisconnect));
  setCommand("gh_credential_clear", withNativeErrors(ghCredentialClear));
  // GitHub PR ops (create/update/markReady/get/list/merge/checks/commits/
  // reviews/comment), cross-tool interop (git_list_all_branches,
  // workspace_create_from_branch), the background-rename hook
  // (workspace_propose_branch_name), and detach mode all moved off Electron main
  // (single-writer). PR ops run on the engine bridge with the token couriered
  // there; detach is dead code (removed).

  // Roadmap 03a UI Phase 1A modals (2026-05-20):
  // workspace_init_repo — fresh git repo via Quick Start dialog.
  // workspace_clone     — clone a remote URL via Open GitHub project.
  // Both produce a repoRoot; the renderer then registers it as a
  // project + (optionally) calls workspace_create for the first
  // worktree.
  setCommand("workspace_init_repo", workspaceInitRepo);
  setCommand("workspace_clone", workspaceClone);
  setCommand("workspace_inspect_folder", workspaceInspectFolder);
  setCommand("dialog_pick_folder", dialogPickFolder);

  // Interactive PTY sessions are now ENGINE-owned (src/engine/pty/) and reached
  // over the bridge by both desktop + web (shared-PTY / Paseo model), so the
  // legacy Electron-IPC pty_* handlers were retired. See src/native/pty.ts.

  // Custom window chrome — drag + zoom via JS instead of CSS drag
  // region, so column headers can keep firing click events for popover
  // dismissal. See electron/ipc/commands/window.ts.
  setCommand("window_drag_start", windowDragStart);
  setCommand("window_drag_end", windowDragEnd);
  setCommand("window_zoom_toggle", windowZoomToggle);
  // Theme-aware native window background (see window.ts) — the
  // renderer reports the resolved --bg1 after each theme change.
  setCommand("window_set_background", windowSetBackground);
  // Durable appearance mode + nativeTheme sync (see window.ts) — the
  // renderer reports the theme MODE after each apply; main persists it
  // to userData (purge-proof) and points native chrome at the app theme.
  setCommand("appearance_set_mode", appearanceSetMode);
}
