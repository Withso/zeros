// app.zeros.build/auth/logout?return=<https zeros.build url>
//
// Ends the browser session through Railway, which revokes the WorkOS session
// and clears the session cookie (lib/workos-browser.mjs). GET (not POST) so a
// plain link works; it only tears down the caller's own session, so the worst
// a forged request does is sign the victim out. `return` is host-allow-listed
// so it can't be an open redirect.

import type { Env } from "../../lib/session";
import { logoutWorkOSBrowserSession } from "../../lib/workos-browser.mjs";

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) =>
  logoutWorkOSBrowserSession(request, env);
