import { desktopAuthConfig } from "./workos-desktop-config";
import { WorkOSDesktopClient } from "./workos-desktop-client";

let cached: { fingerprint: string; client: WorkOSDesktopClient } | undefined;

export function workOSDesktopClientForMain(): WorkOSDesktopClient {
  const auth = desktopAuthConfig();
  if (auth.provider !== "workos") {
    throw new Error("WorkOS desktop authentication is not active");
  }
  const fingerprint = JSON.stringify(auth);
  if (cached?.fingerprint === fingerprint) return cached.client;
  const client = new WorkOSDesktopClient({
    config: {
      clientId: auth.desktopClientId,
      issuer: auth.issuer,
      jwksUrl: auth.jwksUrl,
      audience: auth.audience,
    },
  });
  cached = { fingerprint, client };
  return client;
}
