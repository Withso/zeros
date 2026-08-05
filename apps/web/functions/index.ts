// app.zeros.build/  — the session-aware hub (canonical landing after sign-in).
// Replaces the old static "open the desktop app" page so a signed-in user (and a
// post-OAuth Site-URL fallback) lands on "Launch Zeros". See lib/hub.ts.

import { renderHub } from "../lib/hub";
import type { Env } from "../lib/session";

export const onRequestGet: PagesFunction<Env> = ({ request, env }) =>
  renderHub(request, env);
