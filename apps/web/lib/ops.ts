import { proxyControlPlane } from "./control-plane-proxy";
import { appOrigin } from "./hosts";
import { opsConsolePage, opsPolicy, opsStatePage } from "./ops-pages.mjs";
import { getVerifiedSessionWithId, type Env } from "./session";

type OpsSession = Parameters<typeof opsConsolePage>[0]["session"];

/** An Ops page with its own policy: the host's, plus its one nonce. */
function page(
  body: string,
  status: number,
  nonces: { styleNonce?: string; scriptNonce?: string },
): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      pragma: "no-cache",
      "content-security-policy": opsPolicy(nonces),
    },
  });
}

function newNonce(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

function statePage(
  kind: Parameters<typeof opsStatePage>[0],
  href: string,
  status: number,
): Response {
  const nonce = newNonce();
  return page(opsStatePage(kind, { href, nonce }), status, { styleNonce: nonce });
}

function startHref(env: Env): string {
  return `/auth/start?max_age=300&return=${encodeURIComponent(`${appOrigin(env)}/`)}`;
}

function signOutHref(env: Env): string {
  return `/auth/logout?return=${encodeURIComponent(`${appOrigin(env)}/`)}`;
}

export async function renderOps(request: Request, env: Env): Promise<Response> {
  const verified = await getVerifiedSessionWithId(env, request).catch(() => null);
  if (!verified) return statePage("signIn", startHref(env), 401);
  const headers = new Headers({ accept: "application/json" });
  const cookie = request.headers.get("Cookie");
  if (cookie) headers.set("Cookie", cookie);
  const response = await proxyControlPlane(
    new Request(new URL("/api/v1/ops/session", request.url), { headers }),
    env,
    verified,
  );
  if (response.status === 401) return statePage("reauthenticate", startHref(env), 401);
  if (response.status === 403 || response.status === 404) {
    return statePage("denied", signOutHref(env), 404);
  }
  if (!response.ok) return statePage("unavailable", "/", 503);
  const session = (await response.json()) as OpsSession;
  const nonce = newNonce();
  return page(
    opsConsolePage({
      session,
      section: new URL(request.url).searchParams.get("section"),
      signOutHref: signOutHref(env),
      nonce,
    }),
    200,
    { scriptNonce: nonce },
  );
}
