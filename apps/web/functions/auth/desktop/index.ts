import { renderWorkOSDesktopAuthorizationPage } from "../../../lib/workos-desktop-authorization.mjs";
import type { Env } from "../../../lib/session";

export const onRequestGet: PagesFunction<Env> = ({ request, env }) =>
  renderWorkOSDesktopAuthorizationPage(request, env);
