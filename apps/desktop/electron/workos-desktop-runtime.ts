import { desktopAuthConfig } from "./workos-desktop-config";
import { WorkOSDesktopClient } from "./workos-desktop-client";
import { controlPlaneBaseUrl } from "./workos-desktop-account";

let cached: { fingerprint: string; client: WorkOSDesktopClient } | undefined;

export function workOSDesktopClientForMain(): WorkOSDesktopClient {
  const auth = desktopAuthConfig();
  if (auth.provider !== "workos") {
    throw new Error("WorkOS desktop authentication is not active");
  }
  const controlPlaneOrigin = controlPlaneBaseUrl();
  const fingerprint = JSON.stringify({ auth, controlPlaneOrigin });
  if (cached?.fingerprint === fingerprint) return cached.client;
  const client = new WorkOSDesktopClient({
    config: {
      clientId: auth.desktopClientId,
      issuer: auth.issuer,
      jwksUrl: auth.jwksUrl,
      audience: auth.audience,
    },
    controlPlaneOrigin,
  });
  cached = { fingerprint, client };
  return client;
}
