import type { Env } from "../../lib/session";
import { handleWorkOSDesktopRevocationRequest } from "../../lib/workos-desktop-revocation.mjs";

export const onRequestPost: PagesFunction<Env> = ({ request, env }) =>
  handleWorkOSDesktopRevocationRequest(request, env);
