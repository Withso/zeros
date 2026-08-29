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
