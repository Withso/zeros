// ──────────────────────────────────────────────────────────
// Security audit log — append-only JSONL trail of remote-access events
// ──────────────────────────────────────────────────────────
//
// Forensic record for "what device connected, when, as which account, and what
// happened" — the gap a remote-access product otherwise leaves open (pairing,
// account binding, revocation, serverId rotation, session expiry, sign-out all
// previously emitted only ephemeral console.log). Written next to the daemon
// identity files (devices.json / server-id), 0600.
//
// PRIVACY: never records tokens or any secret. Device ids are public keys; the
// account `sub` is the user's own id on their own machine. This stays local.
//
// Best-effort + synchronous append: a logging failure must never break an auth
// path, so every write is wrapped and swallowed.
// ──────────────────────────────────────────────────────────

import * as fs from "node:fs";
import * as path from "node:path";
import { zerosDataDir } from "../db/paths";

const AUDIT_FILE = "security-audit.jsonl";
// Soft cap so the trail can't grow unbounded on a long-lived desktop; on
// overflow we keep the most-recent ~half (checked cheaply by file size).
const MAX_BYTES = 2 * 1024 * 1024;

export type SecurityAuditEvent =
  | { type: "device-paired"; deviceId: string; label?: string }
  | { type: "device-revoked"; deviceId: string }
  | { type: "server-rotated" }
  | { type: "account-bound"; clientId: string; accountSub: string }
  | { type: "account-rejected"; clientId: string; reason: string }
  | { type: "session-expired"; clientId: string; accountSub?: string }
  | { type: "owner-signed-out" };

/** Default location = the daemon identity dir (ZEROS_HOME, else the app-data
 *  dir) so the audit trail sits with devices.json. Callers that already hold a
 *  home dir (KeyManager) pass it explicitly so tests land in their temp dir. */
function auditDir(dir?: string): string {
  return dir ?? process.env.ZEROS_HOME ?? zerosDataDir();
}

/** Append one security event as a JSON line. Best-effort; never throws. */
export function appendSecurityAudit(
  event: SecurityAuditEvent,
  dir?: string,
): void {
  try {
    const file = path.join(auditDir(dir), AUDIT_FILE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    rotateIfLarge(file);
    const line =
      JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n";
    fs.appendFileSync(file, line, { mode: 0o600 });
  } catch {
    /* auditing must never break an auth path */
  }
}

function rotateIfLarge(file: string): void {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r+");
    const { size } = fs.fstatSync(fd);
    if (size < MAX_BYTES) return;
    const tailStart = Math.max(0, size - Math.floor(MAX_BYTES / 2));
    const tail = Buffer.alloc(size - tailStart);
    fs.readSync(fd, tail, 0, tail.length, tailStart);
    // Drop the partial leading line so the file stays valid JSONL.
    const nl = tail.indexOf(0x0a);
    const retained = nl >= 0 ? tail.subarray(nl + 1) : tail;
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, retained, 0, retained.length, 0);
    fs.fchmodSync(fd, 0o600);
  } catch {
    /* ignore — the next append still works */
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/** Read the most recent `limit` events (oldest→newest). For a future Settings
 *  "security activity" view; returns [] if the file is absent/unreadable. */
export function readSecurityAudit(
  limit = 200,
  dir?: string,
): Array<SecurityAuditEvent & { ts: string }> {
  try {
    const raw = fs
      .readFileSync(path.join(auditDir(dir), AUDIT_FILE), "utf-8")
      .trim();
    if (!raw) return [];
    return raw
      .split("\n")
      .slice(-limit)
      .map((l) => {
        try {
          return JSON.parse(l) as SecurityAuditEvent & { ts: string };
        } catch {
          return null;
        }
      })
      .filter((x): x is SecurityAuditEvent & { ts: string } => x !== null);
  } catch {
    return [];
  }
}
