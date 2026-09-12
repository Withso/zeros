import { isIP } from "node:net";

import { CLOUD_WORKSPACES_DESKTOP_CAPABILITY_ENV } from "../apps/desktop/src/engine/cloud-workspace-capability";

const EXPECTED = {
  alpha: {
    app: "https://app-alpha.zeros.build",
    api: "https://api-alpha.zeros.build",
  },
  beta: {
    app: "https://app-beta.zeros.build",
    api: "https://api-beta.zeros.build",
  },
  production: {
    app: "https://app.zeros.build",
    api: "https://api.zeros.build",
  },
} as const;

const DNS_NAME_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/;
const SSH_HOST_KEY_TYPE_PATTERN = /^[A-Za-z0-9@._+-]{1,128}$/;
const SSH_HOST_KEY_BLOB_PATTERN = /^[A-Za-z0-9+/]{16,21844}={0,2}$/;
const RELEASE_SSH_HOSTS = new Set(["ssh.app.daytona.io"]);

export type HostedReleaseEnvironment = keyof typeof EXPECTED;

function httpsOrigin(raw: string | undefined): string | null {
  try {
    const url = new URL(raw ?? "");
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function exactHttpsUrl(raw: string | undefined): string | null {
  try {
    const url = new URL(raw ?? "");
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return raw?.trim() || null;
  } catch {
    return null;
  }
}

function validPreviewHostSuffixes(raw: string | undefined): boolean {
  if (!raw || raw.length > 8 * 254) return false;
  const entries = raw.split(",").map((entry) => entry.trim());
  return (
    entries.length >= 1 &&
    entries.length <= 8 &&
    new Set(entries).size === entries.length &&
    entries.every(
      (entry) =>
        entry === entry.toLowerCase() &&
        entry.includes(".") &&
        isIP(entry) === 0 &&
        DNS_NAME_PATTERN.test(entry) &&
        !entry.includes(".."),
    )
  );
}

function pinnedKnownHost(value: string): string | null {
  if (value !== value.trim() || value.length > 24 * 1024) return null;
  const fields = value.split(/[ \t]+/);
  if (fields.length !== 3) return null;
  const [host, keyType, encoded] = fields as [string, string, string];
  if (
    host !== host.toLowerCase() ||
    !DNS_NAME_PATTERN.test(host) ||
    host.includes("..") ||
    !SSH_HOST_KEY_TYPE_PATTERN.test(keyType) ||
    !SSH_HOST_KEY_BLOB_PATTERN.test(encoded)
  ) {
    return null;
  }
  try {
    const blob = Buffer.from(encoded, "base64");
    if (
      blob.length < 8 ||
      blob.length > 16 * 1024 ||
      blob.toString("base64").replace(/=+$/u, "") !==
        encoded.replace(/=+$/u, "")
    ) {
      return null;
    }
    const algorithmLength = blob.readUInt32BE(0);
    if (
      algorithmLength < 1 ||
      algorithmLength > 128 ||
      4 + algorithmLength >= blob.length ||
      blob.subarray(4, 4 + algorithmLength).toString("ascii") !== keyType
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return host;
}

function validSshKnownHosts(raw: string | undefined): boolean {
  const encoded = raw?.trim() ?? "";
  if (
    encoded.length < 1 ||
    encoded.length > 128 * 1024 ||
    !/^[A-Za-z0-9_-]+$/u.test(encoded)
  ) {
    return false;
  }
  const bytes = Buffer.from(encoded, "base64url");
  try {
    if (
      bytes.length < 16 ||
      bytes.length > 96 * 1024 ||
      bytes.toString("base64url") !== encoded
    ) {
      return false;
    }
    const document = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const entries = document.endsWith("\n")
      ? document.slice(0, -1).split("\n")
      : document.split("\n");
    if (
      entries.length < 1 ||
      entries.length > 32 ||
      new Set(entries).size !== entries.length
    ) {
      return false;
    }
    const hosts = entries.map(pinnedKnownHost);
    return (
      hosts.every(
        (host): host is string => host !== null && RELEASE_SSH_HOSTS.has(host),
      ) && [...RELEASE_SSH_HOSTS].every((host) => hosts.includes(host))
    );
  } catch {
    return false;
  } finally {
    bytes.fill(0);
  }
}

export function releaseEnvironmentErrors(
  environment: HostedReleaseEnvironment,
  env: NodeJS.ProcessEnv,
): string[] {
  const expected = EXPECTED[environment];
  const errors: string[] = [];
  if (httpsOrigin(env.VITE_APP_BASE_URL) !== expected.app) {
    errors.push(`VITE_APP_BASE_URL must be ${expected.app}`);
  }
  if (httpsOrigin(env.VITE_CONTROL_PLANE_URL) !== expected.api) {
    errors.push(`VITE_CONTROL_PLANE_URL must be ${expected.api}`);
  }
  const cloudWorkspacesEnabled = env[CLOUD_WORKSPACES_DESKTOP_CAPABILITY_ENV];
  if (
    cloudWorkspacesEnabled !== undefined &&
    cloudWorkspacesEnabled !== "" &&
    cloudWorkspacesEnabled !== "true" &&
    cloudWorkspacesEnabled !== "false"
  ) {
    errors.push(
      "ZEROS_CLOUD_WORKSPACES_ENABLED must be true or false when set",
    );
  }
  if (cloudWorkspacesEnabled === "true") {
    const previewSuffixes = env.VITE_CLOUD_WORKSPACE_PREVIEW_HOST_SUFFIXES;
    if (!previewSuffixes?.trim()) {
      errors.push(
        "VITE_CLOUD_WORKSPACE_PREVIEW_HOST_SUFFIXES is required when ZEROS_CLOUD_WORKSPACES_ENABLED=true",
      );
    } else if (!validPreviewHostSuffixes(previewSuffixes)) {
      errors.push(
        "VITE_CLOUD_WORKSPACE_PREVIEW_HOST_SUFFIXES must contain 1-8 exact lowercase DNS suffixes",
      );
    }
    const knownHosts = env.VITE_CLOUD_WORKSPACE_SSH_KNOWN_HOSTS_B64;
    if (!knownHosts?.trim()) {
      errors.push(
        "VITE_CLOUD_WORKSPACE_SSH_KNOWN_HOSTS_B64 is required when ZEROS_CLOUD_WORKSPACES_ENABLED=true",
      );
    } else if (!validSshKnownHosts(knownHosts)) {
      errors.push(
        "VITE_CLOUD_WORKSPACE_SSH_KNOWN_HOSTS_B64 must be canonical base64url for a valid OpenSSH known_hosts document covering every allowed SSH host",
      );
    }
  }
  const authProvider = env.AUTH_PROVIDER?.trim().toLowerCase();
  if (authProvider !== "auth0" && authProvider !== "workos") {
    errors.push("AUTH_PROVIDER must be auth0 or workos");
  }
  if (authProvider === "workos") {
    const desktopClientId = env.AUTH_DESKTOP_CLIENT_ID?.trim() ?? "";
    if (!desktopClientId) {
      errors.push("AUTH_DESKTOP_CLIENT_ID is required in WorkOS mode");
    } else if (!desktopClientId.startsWith("client_")) {
      errors.push("AUTH_DESKTOP_CLIENT_ID must be a WorkOS client ID");
    }
    if (!exactHttpsUrl(env.AUTH_ISSUER)) {
      errors.push("AUTH_ISSUER must be an exact HTTPS URL in WorkOS mode");
    }
    if (!exactHttpsUrl(env.AUTH_JWKS_URL)) {
      errors.push("AUTH_JWKS_URL must be an exact HTTPS URL in WorkOS mode");
    }
    if (env.AUTH_AUDIENCE?.trim() !== expected.api) {
      errors.push(`AUTH_AUDIENCE must be ${expected.api} in WorkOS mode`);
    }
  }
  for (const [name, value] of Object.entries(env)) {
    if (/^WORKOS(?:_[A-Z0-9]+)*_API_KEY$/i.test(name) && value?.trim()) {
      errors.push(`${name} must never be present in a desktop build`);
    }
  }
  const ref = env.GITHUB_REF?.trim();
  if (ref) {
    const validRef =
      environment === "alpha"
        ? ref === "refs/heads/main"
        : /^refs\/heads\/release\/\d+\.\d+\.\d+$/.test(ref);
    if (!validRef) {
      errors.push(
        `${environment} releases must run from ${
          environment === "alpha" ? "main" : "release/X.Y.Z"
        }`,
      );
    }
  }
  return errors;
}

const requested = process.argv[2] as HostedReleaseEnvironment | undefined;
if (process.argv[1]?.endsWith("release-environment.ts")) {
  if (!requested || !(requested in EXPECTED)) {
    console.error("Usage: release-environment.ts alpha|beta|production");
    process.exit(1);
  }
  const errors = releaseEnvironmentErrors(requested, process.env);
  if (errors.length > 0) {
    console.error(`Unsafe ${requested} hosted environment routing:`);
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log(`Hosted environment routing verified: ${requested}`);
}
