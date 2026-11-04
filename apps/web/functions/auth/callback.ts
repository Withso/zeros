// app.zeros.build/auth/callback?code=&state=
//
// Hosted AuthKit returns here after sign-in. Railway verifies the state and
// PKCE exchange and sets the browser session; this Pages function forwards
// the request unchanged (lib/workos-browser.mjs).

import type { Env } from "../../lib/session";
import { finishWorkOSBrowserAuth } from "../../lib/workos-browser.mjs";

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) =>
  finishWorkOSBrowserAuth(request, env);
