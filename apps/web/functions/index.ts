// app.zeros.build/ — signed-out auth hub and signed-in organization dashboard.
// Desktop handoffs still use the same renderer when their validated launch
// context is present. See lib/hub.ts.

import { renderHub } from "../lib/hub";
import type { Env } from "../lib/session";

export const onRequestGet: PagesFunction<Env> = ({ request, env }) =>
  renderHub(request, env);
