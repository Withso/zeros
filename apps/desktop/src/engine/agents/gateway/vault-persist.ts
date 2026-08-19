// ──────────────────────────────────────────────────────────
// MCP gateway — OAuth token-vault persistence wire format
// ──────────────────────────────────────────────────────────
//
// The gateway MINTS OAuth tokens in the engine (bun), but the only durable,
// encrypted-at-rest store is Electron `safeStorage`, which lives in the HOST
// (main) process. So the engine and the host courier the vault over the EXISTING
// private host↔engine pipes — NOT the renderer (an XSS there must never read a
// token, mirroring the GitHub-token handling) and not the relay bridge:
//
//   host safeStorage ──(stdin: host.mcpVault)──▶ engine vault.restore()   (boot)
//   engine vault.onChange ──(control-fd: mcp.vault)──▶ host safeStorage    (mint/refresh)
//
// Why a dedicated control fd for the engine→host direction (not stdout): stdout
// is forwarded to main.log / engine.log, so a token blob there would sit in a
// plaintext log on disk. fd 3 is a private pipe the host reads directly and never
// logs. Why stdin (not an env var) for restore: an env blob is inherited by every
// agent subprocess the engine spawns (readable via `ps eww`) — stdin is not.
//
// This module is the pure, testable wire format shared by both ends (the engine
// in apps/desktop/src/engine/zeros-engine.ts and the host in apps/desktop/electron/sidecar.ts). It holds NO
// secrets itself and never touches disk.
// ──────────────────────────────────────────────────────────

import type { BackendCredentials } from "./oauth-provider";

/** safeStorage account the host stores the encrypted vault blob under. Uses an
 *  underscore name (like `github_oauth`) — deliberately NOT the `mcp::` prefix,
 *  which `apps/desktop/electron/keychain-accounts.ts` allowlists for the RENDERER's keychain
 *  bridge. A renderer (XSS) can read `mcp::*` env-secret refs but MUST NOT be
 *  able to read this OAuth-token vault. */
export const MCP_VAULT_ACCOUNT = "mcp_oauth_vault";

/** Control-message `type` on the engine→host control fd (persist request). */
export const MCP_VAULT_CONTROL_TYPE = "mcp.vault";
/** Control-message `type` on the host→engine stdin channel (boot restore seed). */
export const MCP_VAULT_SEED_TYPE = "host.mcpVault";
/** Engine→host launch authority. The child mints this per process and returns
 * it over fd 3 so it never appears in `/proc/<pid>/environ` / `ps eww`. */
export const ENGINE_LOCAL_AUTHORITY_CONTROL_TYPE = "engine.localAuthority";

/** The serializable vault, keyed by canonical resource URI (RFC 8707). */
export type VaultSnapshot = Record<string, BackendCredentials>;

function asSnapshot(v: unknown): VaultSnapshot | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as VaultSnapshot)
    : null;
}

/** Parse the restore blob (the host's decrypted safeStorage value). Defensive:
 *  missing / malformed JSON → null, so a corrupt store never throws at boot —
 *  the vault simply starts empty and the user re-authenticates. */
export function parseVaultBlob(
  raw: string | undefined | null,
): VaultSnapshot | null {
  if (!raw) return null;
  try {
    return asSnapshot(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** The engine→host control line (newline-terminated) asking main to persist the
 *  current snapshot. Carries plaintext tokens — only ever written to the private
 *  control fd, never stdout/stderr or the bridge. */
export function vaultControlLine(snapshot: VaultSnapshot): string {
  return `${JSON.stringify({ type: MCP_VAULT_CONTROL_TYPE, data: snapshot })}\n`;
}

/** Host side: extract the snapshot from a control-fd line, or null if the line
 *  isn't a vault-persist message (so the host can ignore anything else). */
export function parseVaultControl(line: string): VaultSnapshot | null {
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== "object") return null;
  const m = msg as { type?: unknown; data?: unknown };
  if (m.type !== MCP_VAULT_CONTROL_TYPE) return null;
  return asSnapshot(m.data);
}

/** Engine side: frame the per-process loopback bearer on the private control
 * fd. It is deliberately separate from the runtime manifest, stdout, and env. */
export function engineLocalAuthorityControlLine(token: string): string {
  if (!/^[a-f0-9]{64}$/.test(token)) {
    throw new Error("invalid engine local authority token");
  }
  return `${JSON.stringify({
    type: ENGINE_LOCAL_AUTHORITY_CONTROL_TYPE,
    token,
  })}\n`;
}

/** Host side: return an exact launch bearer, or null for every other/malformed
 * control message. Never accept loose string values on this authority seam. */
export function parseEngineLocalAuthorityControl(
  line: string,
): string | null {
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== "object") return null;
  const value = msg as { type?: unknown; token?: unknown };
  return value.type === ENGINE_LOCAL_AUTHORITY_CONTROL_TYPE &&
    typeof value.token === "string" &&
    /^[a-f0-9]{64}$/.test(value.token)
    ? value.token
    : null;
}

/** The host→engine stdin line (newline-terminated) seeding the vault at boot. */
export function vaultSeedLine(snapshot: VaultSnapshot): string {
  return `${JSON.stringify({ type: MCP_VAULT_SEED_TYPE, data: snapshot })}\n`;
}
