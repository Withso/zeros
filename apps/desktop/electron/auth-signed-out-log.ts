/** Why a launch or a refresh ended signed out, as one main-log line. The
 * reason is closed; the detail is only a short lower-case code (a provider or
 * server error code, an event kind) or an HTTP status, so no token, email or
 * identifier can reach the log. A repeated state logs once; a valid session in
 * between allows the next one. */
export type SignedOutReason = "refresh_refused" | "stored_session_missing" | "stored_session_unreadable" | "snapshot_401" | "revoked";

const CODE = /^[a-z][a-z0-9_.]{0,47}$/;
let last: string | null = null;

export function logSignedOut(reason: SignedOutReason, detail: { code?: string; status?: number } = {}, sink: (line: string) => void = line => console.warn(line)): void {
  const code = detail.code && CODE.test(detail.code) ? ` code=${detail.code}` : "";
  const status = detail.status !== undefined && Number.isInteger(detail.status) && detail.status >= 100 && detail.status <= 599 ? ` status=${detail.status}` : "";
  const line = `[auth] signed out reason=${reason}${code}${status}`;
  if (line === last) return;
  last = line;
  sink(line);
}

/** A valid session was read: the next signed-out state is news again. */
export function noteSignedIn(): void { last = null; }

export function resetSignedOutLogForTests(): void { last = null; }
