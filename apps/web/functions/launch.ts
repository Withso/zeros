// app.zeros.build/launch?scheme=&nonce=&challenge=
//
// Kept as the desktop entry (the app opens /launch). With valid handoff context
// it launches the app; without context it remains desktop guidance rather than
// silently becoming the organization dashboard. See lib/hub.ts.

import { renderHub } from "../lib/hub";
import type { Env } from "../lib/session";

export const onRequestGet: PagesFunction<Env> = ({ request, env }) =>
  renderHub(request, env);
