// app.zeros.build/invite?token=… — the Zeros-owned invitation entry point.
//
// The control plane stores only the token digest. This page keeps the opaque
// capability inside a no-store, no-referrer, CSP-bounded response and offers
// two explicit continuations:
//
// - the exact release-channel desktop deep link; or
// - same-origin browser acceptance. An unauthenticated browser is routed
//   through Railway's one-time WorkOS state + PKCE ceremony and returns here.
//
// WorkOS mirrors the pending organization invitation but its default
// invitation email is disabled. Otherwise its direct AuthKit link would skip
// this application-owned capability and the Zeros state/PKCE entry boundary.

import { marketingOrigin } from "../lib/hosts";
import { renderInvitationPage } from "../lib/invite-page.mjs";
import { schemeForDeploymentEnvironment } from "../lib/schemes.mjs";
import type { Env } from "../lib/session";

export const onRequestGet: PagesFunction<Env> = ({ request, env }) => {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") ?? "";
  const scheme = schemeForDeploymentEnvironment(
    env.ZEROS_DEPLOY_ENV,
    url.searchParams.get("scheme") ?? "",
  );
  const page = renderInvitationPage({
    token,
    scheme,
    marketingOrigin: marketingOrigin(env),
    mode:
      url.searchParams.get("mode") === "web"
        ? "web"
        : url.searchParams.get("mode") === "resume"
          ? "resume"
          : "landing",
    nonce: crypto.randomUUID().replaceAll("-", ""),
  });
  return new Response(page.html, { headers: page.headers });
};
