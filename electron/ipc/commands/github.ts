// ──────────────────────────────────────────────────────────
// IPC commands: GitHub — AUTH + token courier (single-writer)
// ──────────────────────────────────────────────────────────
//
// The GitHub PR ops moved onto the engine bridge in the single-writer migration
// (they touch zeros.db via getWorkspace, so they run in the engine now). What
// stays here in Electron main is everything that touches ONLY the OS keychain
// (safeStorage), never the DB:
//
//   • gh_auth_status / gh_detect_cli / gh_set_token / gh_sign_out /
//     gh_auth_signin — the three auth paths (CLI, PAT, device-flow OAuth).
//   • gh_token_clear — clears the stored token (safeStorage) and re-pushes to
//     the engine, since the bun engine can't call safeStorage.
//
// (gh_token_get is GONE (H4): the decrypted token is never handed to the
// renderer; main couriers it straight to the engine — spawn env + stdin. The
// deprecated no-op stub outlived its last caller and was removed.)
//
// Device-flow verification code is fanned out via the `gh:device-code` event.
// ──────────────────────────────────────────────────────────

import {
  detectGhCli,
  getAuthStatus,
  setToken,
  signOut,
  startDeviceFlow,
  type DeviceVerification,
} from "../../../src/engine/git";
import { emitEvent } from "../events";
import type { CommandHandler } from "../router";
import { deleteSecret } from "../../secret-store";
import { pushGithubTokenToEngine } from "../../sidecar";

// Mirror of main.ts's GITHUB_OAUTH_ACCOUNT — the safeStorage key the OAuth token
// is encrypted under. Duplicated (a stable string) to keep this module
// self-contained; the two MUST stay in sync.
const GITHUB_OAUTH_ACCOUNT = "github_oauth";

function requireString(
  args: Record<string, unknown>,
  key: string,
  context: string,
): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`${context}: missing required string '${key}'`);
  }
  return v;
}

// ── Auth (safeStorage only) ───────────────────────────────

export const ghAuthStatus: CommandHandler = async () => {
  return await getAuthStatus();
};

/** Auto-detect a `gh` CLI login and adopt its token (primary auth path). */
export const ghDetectCli: CommandHandler = async () => {
  const res = await detectGhCli();
  // H4: courier the (possibly newly-adopted) token straight to the engine.
  pushGithubTokenToEngine();
  return res;
};

/** Adopt a pasted personal access token (paste-a-PAT fallback). */
export const ghSetToken: CommandHandler = async (args) => {
  const token = requireString(args, "token", "gh_set_token");
  const res = await setToken(token);
  pushGithubTokenToEngine();
  return res;
};

export const ghSignOut: CommandHandler = async () => {
  await signOut();
  pushGithubTokenToEngine();
  return null;
};

export const ghAuthSignin: CommandHandler = async () => {
  // The device flow has a "wait for user to authorize" window of up to 15
  // minutes; we resolve only after the user completes. The renderer shows the
  // user_code modal via the `gh:device-code` event.
  const res = await startDeviceFlow({
    onVerification(v: DeviceVerification) {
      emitEvent("gh:device-code", v);
    },
  });
  pushGithubTokenToEngine();
  return res;
};

// ── Token courier (single-writer, option B) ───────────────
//
// The GitHub PR ops now run in the engine (bun), which can't read safeStorage.
// Main couriers the decrypted token straight to the engine (spawn env + stdin;
// H4 — the renderer NEVER holds it, so a renderer XSS can't exfiltrate it).
// gh_token_clear is the one renderer-reachable courier command left: the
// safeStorage side of an engine-originated invalidation. The auth ops above
// still run HERE in main (safeStorage only), so main stays the durable owner —
// the engine only ever holds an in-memory working copy.

/** Clear the stored token — invoked by the renderer when the engine reports an
 *  out-of-band invalidation (GITHUB_TOKEN_CHANGED with token=null, e.g. a 401
 *  auto-clear inside a PR op) so safeStorage stays in sync with the engine. */
export const ghTokenClear: CommandHandler = async () => {
  deleteSecret(GITHUB_OAUTH_ACCOUNT);
  pushGithubTokenToEngine();
  return null;
};
