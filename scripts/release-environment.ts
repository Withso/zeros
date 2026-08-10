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
