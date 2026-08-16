import { isIP } from "node:net";
import { domainToASCII } from "node:url";

const MAX_CREDENTIAL_VALUE_BYTES = 1024 * 1024;

export interface ProviderCredentialCapability {
  /** Exact environment name replaced by an SRT sentinel in the child. */
  readonly name: string;
  /** Canonical destination authorities. A port is always explicit. */
  readonly injectAuthorities: readonly string[];
  /** True only when the provider endpoint itself uses plain HTTP. */
  readonly allowPlaintext: boolean;
}

interface EndpointAuthority {
  readonly authority: string;
  readonly allowPlaintext: boolean;
}

function normalizeEndpoint(
  raw: string | undefined,
  fallback: string,
  label: string,
): EndpointAuthority {
  let parsed: URL;
  try {
    parsed = new URL(raw?.trim() || fallback);
  } catch {
    throw new Error(`${label} must be a valid absolute URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${label} must use HTTP(S)`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${label} must not contain embedded credentials`);
  }
  let hostname = parsed.hostname;
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    hostname = hostname.slice(1, -1);
  }
  hostname = hostname.replace(/\.$/, "").toLowerCase();
  if (!hostname || hostname.includes("*") || hostname.includes("\0")) {
    throw new Error(`${label} contains an invalid host`);
  }
  if (isIP(hostname) === 0) {
    hostname = domainToASCII(hostname);
    if (
      !hostname ||
      hostname.length > 253 ||
      hostname.split(".").some((part) => !part || part.length > 63)
    ) {
      throw new Error(`${label} contains an invalid host`);
    }
  }
  const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} contains an invalid port`);
  }
  return {
    authority: `${isIP(hostname) === 6 ? `[${hostname}]` : hostname}:${port}`,
    allowPlaintext: parsed.protocol === "http:",
  };
}

function hasCredential(env: Readonly<Record<string, string>>, name: string) {
  const value = env[name];
  if (value === undefined || value.trim() === "") return false;
  if (Buffer.byteLength(value) > MAX_CREDENTIAL_VALUE_BYTES) {
    throw new Error(`${name} exceeds the credential projection size limit`);
  }
  return true;
}

function capabilitiesFor(
  env: Readonly<Record<string, string>>,
  names: readonly string[],
  endpoints: readonly EndpointAuthority[],
): ProviderCredentialCapability[] {
  const injectAuthorities = [
    ...new Set(endpoints.map(({ authority }) => authority)),
  ];
  const allowPlaintext = endpoints.some((endpoint) => endpoint.allowPlaintext);
  return names.flatMap((name) =>
    hasCredential(env, name)
      ? [{ name, injectAuthorities, allowPlaintext }]
      : [],
  );
}

/**
 * Compile provider-owned authentication environment into narrow egress
 * capabilities. Unknown providers are deliberately left untouched: a generic
 * application variable must not silently acquire provider credential meaning.
 */
export function deriveProviderCredentialProjection(
  providerId: string | undefined,
  env: Readonly<Record<string, string>>,
): ProviderCredentialCapability[] {
  switch (providerId?.trim().toLowerCase()) {
    case "claude": {
      const endpoint = normalizeEndpoint(
        env.ANTHROPIC_BASE_URL || env.ANTHROPIC_API_URL,
        "https://api.anthropic.com",
        "Claude API endpoint",
      );
      return capabilitiesFor(
        env,
        [
          "ANTHROPIC_API_KEY",
          "ANTHROPIC_AUTH_TOKEN",
          "CLAUDE_CODE_OAUTH_TOKEN",
        ],
        [endpoint],
      );
    }
    case "codex": {
      const openAi = normalizeEndpoint(
        env.OPENAI_BASE_URL || env.OPENAI_API_BASE,
        "https://api.openai.com/v1",
        "OpenAI API endpoint",
      );
      const chatGpt = normalizeEndpoint(
        env.CHATGPT_BASE_URL,
        "https://chatgpt.com/backend-api/codex",
        "ChatGPT API endpoint",
      );
      return [
        ...capabilitiesFor(env, ["OPENAI_API_KEY", "CODEX_API_KEY"], [openAi]),
        ...capabilitiesFor(env, ["CODEX_ACCESS_TOKEN"], [chatGpt]),
      ];
    }
    case "cursor":
      return capabilitiesFor(
        env,
        ["CURSOR_API_KEY"],
        [
          normalizeEndpoint(
            undefined,
            "https://api.cursor.com",
            "Cursor API endpoint",
          ),
          normalizeEndpoint(
            undefined,
            "https://api2.cursor.sh",
            "Cursor inference endpoint",
          ),
        ],
      );
    default:
      return [];
  }
}
