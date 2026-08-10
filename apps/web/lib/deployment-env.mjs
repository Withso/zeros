const CHANNELS = {
  alpha: {
    appOrigin: "https://app-alpha.zeros.build",
    controlPlaneOrigin: "https://api-alpha.zeros.build",
  },
  beta: {
    appOrigin: "https://app-beta.zeros.build",
    controlPlaneOrigin: "https://api-beta.zeros.build",
  },
  production: {
    appOrigin: "https://app.zeros.build",
    controlPlaneOrigin: "https://api.zeros.build",
  },
};

function normalizedHttpsOrigin(raw) {
  try {
    const url = new URL(raw);
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

/**
 * Fail closed only inside Cloudflare Pages. Local builds intentionally keep
 * working without hosted credentials. The three Pages projects share one
 * codebase, but each must name and target exactly one deployment channel.
 */
export function deploymentEnvironmentErrors(env) {
  if (env.CF_PAGES !== "1") return [];

  const errors = [];
  const channel = (env.ZEROS_DEPLOY_ENV || "").trim();
  const expected = CHANNELS[channel];
  if (!expected) {
    errors.push("ZEROS_DEPLOY_ENV must be alpha, beta, or production");
    return errors;
  }

  for (const name of [
    "AUTH0_DOMAIN",
    "AUTH0_CLIENT_ID",
    "AUTH0_CLIENT_SECRET",
    "AUTH0_AUDIENCE",
    "APP_ORIGIN",
    "CONTROL_PLANE_URL",
  ]) {
    if (!(env[name] || "").trim()) errors.push(`${name} is required`);
  }

  if (normalizedHttpsOrigin(env.APP_ORIGIN || "") !== expected.appOrigin) {
    errors.push(`APP_ORIGIN must be ${expected.appOrigin} for ${channel}`);
  }
  if (
    normalizedHttpsOrigin(env.CONTROL_PLANE_URL || "") !==
    expected.controlPlaneOrigin
  ) {
    errors.push(
      `CONTROL_PLANE_URL must be ${expected.controlPlaneOrigin} for ${channel}`,
    );
  }
  if ((env.AUTH0_AUDIENCE || "").trim() !== expected.controlPlaneOrigin) {
    errors.push(
      `AUTH0_AUDIENCE must be ${expected.controlPlaneOrigin} for ${channel}`,
    );
  }

  const branch = (env.CF_PAGES_BRANCH || "").trim();
  if (!branch) {
    errors.push("CF_PAGES_BRANCH is required");
  } else if (channel === "alpha" && branch !== "main") {
    errors.push("Alpha Pages deployments must build main");
  } else if (
    (channel === "beta" || channel === "production") &&
    !/^release\/\d+\.\d+\.\d+$/.test(branch)
  ) {
    errors.push(
      `${channel === "beta" ? "Beta" : "Production"} Pages deployments must build release/X.Y.Z`,
    );
  }
  return errors;
}
