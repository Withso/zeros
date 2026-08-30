// app.zeros.build/invite?... — the bounded Zeros invitation entry point.
//
// The control plane stores only the token digest. This page keeps the opaque
// capability inside a no-store, no-referrer, CSP-bounded response and offers
// two explicit continuations:
//
// - the exact release-channel desktop deep link; or
// - same-origin browser acceptance. An unauthenticated browser is routed
//   through Railway's one-time WorkOS state + PKCE ceremony and returns here.
//
// In WorkOS mode its native branded email uses the configured custom
// invitation URL and appends `invitation_token`. Railway resolves that token
// against the exact Zeros invitation before product access changes. The legacy
// `token` parameter remains for Auth0 rollback and copyable-link compatibility.

import { marketingOrigin } from "../lib/hosts";
import {
  invitationTokenFromSearchParams,
  renderInvitationPage,
} from "../lib/invite-page.mjs";
import { schemeForDeploymentEnvironment } from "../lib/schemes.mjs";
import type { Env } from "../lib/session";

export const onRequestGet: PagesFunction<Env> = ({ request, env }) => {
  const url = new URL(request.url);
  const { token, tokenParameter } = invitationTokenFromSearchParams(
    url.searchParams,
  );
  const scheme = schemeForDeploymentEnvironment(
    env.ZEROS_DEPLOY_ENV,
    url.searchParams.get("scheme") ?? "",
  );
  const page = renderInvitationPage({
    token,
    tokenParameter,
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
