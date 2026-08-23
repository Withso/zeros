import { appBaseUrl } from "./app-base-url";

const REVOCATION_REQUEST_TIMEOUT_MS = 30_000;

export async function requestWorkOSDesktopRevocation(
  scope: "current" | "all",
  accessToken: string,
): Promise<boolean> {
  if (!accessToken) return false;
  try {
    const response = await fetch(`${appBaseUrl()}/auth/desktop-revoke`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ scope }),
      signal: AbortSignal.timeout(REVOCATION_REQUEST_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}
