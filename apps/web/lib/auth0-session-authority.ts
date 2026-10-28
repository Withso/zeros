import type { Env, SessionData } from "./session";
import { workosControlPlaneOrigin } from "./workos-railway.mjs";
import { readBoundedResponseBody } from "./control-plane-policy.mjs";

type Result = { status: "terminal"; revokedAll?: boolean } | {
  status: "active" | "busy" | "lease"; data: SessionData; revision: number; expiresAt: number; lease?: string; desktopCredential?: string;
};
export type Auth0AuthorityCommand =
  | { action: "create"; sessionId: string; data: SessionData; issuedAt: number }
  | { action: "read"; sessionId: string }
  | { action: "revoke"; sessionId: string; all?: boolean }
  | { action: "begin"; sessionId: string; revision: number }
  | { action: "commit"; sessionId: string; lease: string; data: SessionData }
  | { action: "release"; sessionId: string; lease: string; terminal: boolean }
  | { action: "ticket"; sessionId: string; ticket: string; challenge: string }
  | { action: "redeem"; sessionId: string; challenge: string };

export async function auth0SessionAuthority(env: Env, command: Auth0AuthorityCommand): Promise<Result> {
  if (!/^(?:z0d_)?[A-Za-z0-9_-]{43}$/.test(command.sessionId)) return { status: "terminal" };
  if (!/^[a-f\d]{64}$/i.test(env.AUTH0_SESSION_AUTHORITY_KEY ?? ""))
    throw new Error("Auth0 session authority is not configured");
  const response = await fetch(`${workosControlPlaneOrigin(env)}/auth/compat/session`, {
    method: "POST", redirect: "manual", signal: AbortSignal.timeout(10_000),
    headers: { "content-type": "application/json", authorization: `Bearer ${env.AUTH0_SESSION_AUTHORITY_KEY}` },
    body: JSON.stringify(command),
  });
  if (!response.ok) throw new Error("Auth0 session authority is unavailable");
  const body = await readBoundedResponseBody(response, 128 * 1024);
  if (!body.ok) throw new Error("Invalid Auth0 session authority response");
  const value = JSON.parse(new TextDecoder().decode(body.body)) as Result;
  if (value?.status === "terminal") return value;
  if (!value || !["active", "busy", "lease"].includes(value.status) || !Number.isSafeInteger(value.revision) || value.revision < 1 ||
    !Number.isFinite(value.expiresAt) || !value.data || typeof value.data.sub !== "string" || typeof value.data.email !== "string" ||
    typeof value.data.accessToken !== "string" || (value.data.refreshToken !== null && typeof value.data.refreshToken !== "string") ||
    (value.status === "lease" && !/^[A-Za-z0-9_-]{43}$/.test(value.lease ?? "")))
    throw new Error("Invalid Auth0 session authority response");
  return value;
}
