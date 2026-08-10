import { proxyControlPlane } from "../../lib/control-plane-proxy";
import type { Env } from "../../lib/session";

export const onRequest: PagesFunction<Env> = ({ request, env }) =>
  proxyControlPlane(request, env);
