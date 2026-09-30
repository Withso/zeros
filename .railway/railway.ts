import { defineRailway, project, service } from "railway/iac";

export const partial = "zeros-control-plane";

export default defineRailway((context) => {
  const channel = context.environmentName ?? context.environment;
  if (!["alpha", "beta", "production"].includes(channel ?? "")) {
    throw new Error(
      "Link an existing alpha, beta, or production Railway environment before planning.",
    );
  }
  const branch = channel === "alpha" ? "main" : process.env.RELEASE_BRANCH;
  if (channel !== "alpha" && !/^release\/\d+\.\d+\.\d+$/.test(branch ?? "")) {
    throw new Error(
      "Beta and Production IaC require the reviewed RELEASE_BRANCH=release/X.Y.Z.",
    );
  }
  if (!context.projectName)
    throw new Error(
      "Link the existing Railway project; IaC must not create or rename it.",
    );

  const controlPlane = service("zeros", {
    source: { repo: "Withso/zeros", branch },
    rootDirectory: "apps/control-plane",
    build: {
      builder: "DOCKERFILE",
      dockerfilePath: "Dockerfile",
      watchPatterns: ["/apps/control-plane/**"],
    },
    deploy: {
      healthcheckPath: "/healthz",
      healthcheckTimeout: 60,
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 5,
    },
  });
  return project(context.projectName, { resources: [controlPlane] });
});
