// app.zeros.build/ — signed-out sign-in hub and signed-in organization
// dashboard. See lib/hub.ts.

import { renderHub } from "../lib/hub";
import { renderOps } from "../lib/ops";
import type { Env } from "../lib/session";

export const onRequestGet: PagesFunction<Env> = ({ request, env }) =>
  env.ZEROS_SURFACE === "ops"
    ? renderOps(request, env)
    : renderHub(request, env);
