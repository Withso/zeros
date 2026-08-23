import type { Env } from "../../lib/session";
import { handleWorkOSWebhook } from "../../lib/workos-webhook.mjs";

/** WorkOS sends signed user.updated/user.deleted events here. The exact raw
 * body is authenticated before a reduced lifecycle event crosses the separate
 * broker-to-control-plane boundary. */
export const onRequestPost: PagesFunction<Env> = ({ request, env }) =>
  handleWorkOSWebhook(request, env);
