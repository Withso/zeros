// app.zeros.build/auth/start?return=
//
// Starts the browser sign-in. Railway creates the PKCE state and cookies and
// redirects to Hosted AuthKit; this Pages function is a stateless same-origin
// facade (lib/workos-browser.mjs).

import type { Env } from "../../lib/session";
import { beginWorkOSBrowserAuth } from "../../lib/workos-browser.mjs";

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) =>
  beginWorkOSBrowserAuth(request, env);
