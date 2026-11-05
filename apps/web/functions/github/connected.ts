// app.zeros.build/github/connected#scheme=&nonce=&error=
//
// GitHub's confidential OAuth exchange finishes on the control plane, which
// redirects here with only the desktop handoff in the fragment. Fragments do
// not cross the HTTP boundary, so Cloudflare never receives the nonce. The
// page validates it in-browser, removes it from visible history, and offers a
// user-gesture-backed custom-protocol link to the exact Zeros release channel
// that started the connection (lib/github-completion.mjs).

import { githubCompletionPage } from "../../lib/github-completion.mjs";
import { html } from "../../lib/page";
import { deploymentAppLink } from "../../lib/schemes.mjs";
import type { Env } from "../../lib/session";

export const onRequestGet: PagesFunction<Env> = ({ env }) =>
  html(githubCompletionPage(deploymentAppLink(env.ZEROS_DEPLOY_ENV)));
