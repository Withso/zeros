// Provider-neutral desktop authentication configuration. Public WorkOS values
// are baked into Electron main at release compile time; secrets are neither
// accepted nor represented by this module.

declare const __ZEROS_AUTH_PROVIDER_BAKED__: string | undefined;
declare const __ZEROS_AUTH_DESKTOP_CLIENT_ID_BAKED__: string | undefined;
declare const __ZEROS_AUTH_ISSUER_BAKED__: string | undefined;
declare const __ZEROS_AUTH_JWKS_URL_BAKED__: string | undefined;
declare const __ZEROS_AUTH_AUDIENCE_BAKED__: string | undefined;

export type DesktopAuthConfig =
  | { provider: "auth0" }
  | {
      provider: "workos";
      desktopClientId: string;
      issuer: string;
      jwksUrl: string;
      audience: string;
    };

export interface DesktopAuthConfigInput {
  provider?: string;
  desktopClientId?: string;
  issuer?: string;
  jwksUrl?: string;
  audience?: string;
}

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim() ?? "";
  if (!normalized) throw new Error(`${name} must be configured`);
  return normalized;
}

function exactHttpsUrl(value: string | undefined, name: string): string {
  const raw = required(value, name);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} must be an HTTPS URL`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error(`${name} must be an HTTPS URL without credentials`);
  }
  if (parsed.search || parsed.hash) {
    throw new Error(`${name} must not contain a query or fragment`);
  }
  // Issuer matching is byte-for-byte. Validation may parse the value, but it
  // must never canonicalize away a path slash or otherwise rewrite the
  // operator-qualified token contract.
  return raw;
}

export function resolveDesktopAuthConfig(
  input: DesktopAuthConfigInput,
): DesktopAuthConfig {
  const provider = (input.provider ?? "auth0").trim().toLowerCase();
  if (provider === "auth0") return { provider };
  if (provider !== "workos") {
    throw new Error("Desktop authentication provider must be auth0 or workos");
  }
  const desktopClientId = required(
    input.desktopClientId,
    "AUTH_DESKTOP_CLIENT_ID",
  );
  if (!desktopClientId.startsWith("client_") || desktopClientId.length > 256) {
    throw new Error("AUTH_DESKTOP_CLIENT_ID must be a WorkOS client ID");
  }
  return {
    provider,
    desktopClientId,
    issuer: exactHttpsUrl(input.issuer, "AUTH_ISSUER"),
    jwksUrl: exactHttpsUrl(input.jwksUrl, "AUTH_JWKS_URL"),
    audience: required(input.audience, "AUTH_AUDIENCE"),
  };
}

function baked(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function desktopAuthConfig(): DesktopAuthConfig {
  return resolveDesktopAuthConfig({
    provider:
      process.env.ZEROS_AUTH_PROVIDER?.trim() ||
      process.env.AUTH_PROVIDER?.trim() ||
      baked(
        typeof __ZEROS_AUTH_PROVIDER_BAKED__ === "string"
          ? __ZEROS_AUTH_PROVIDER_BAKED__
          : "",
      ) ||
      "auth0",
    desktopClientId:
      process.env.AUTH_DESKTOP_CLIENT_ID?.trim() ||
      baked(
        typeof __ZEROS_AUTH_DESKTOP_CLIENT_ID_BAKED__ === "string"
          ? __ZEROS_AUTH_DESKTOP_CLIENT_ID_BAKED__
          : "",
      ),
    issuer:
      process.env.AUTH_ISSUER?.trim() ||
      baked(
        typeof __ZEROS_AUTH_ISSUER_BAKED__ === "string"
          ? __ZEROS_AUTH_ISSUER_BAKED__
          : "",
      ),
    jwksUrl:
      process.env.AUTH_JWKS_URL?.trim() ||
      baked(
        typeof __ZEROS_AUTH_JWKS_URL_BAKED__ === "string"
          ? __ZEROS_AUTH_JWKS_URL_BAKED__
          : "",
      ),
    audience:
      process.env.AUTH_AUDIENCE?.trim() ||
      baked(
        typeof __ZEROS_AUTH_AUDIENCE_BAKED__ === "string"
          ? __ZEROS_AUTH_AUDIENCE_BAKED__
          : "",
      ),
  });
}
