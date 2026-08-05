// app.zeros.build/launch?scheme=&nonce=&challenge=
//
// Kept as an entry alias (the desktop may open /launch); it renders the same
// session-aware hub as `/`. The hub canonicalizes the post-sign-in return to the
// root `/`, so this is just an initial entry point. See lib/hub.ts.

import { renderHub } from "../lib/hub";
import type { Env } from "../lib/session";

export const onRequestGet: PagesFunction<Env> = ({ request, env }) =>
  renderHub(request, env);
