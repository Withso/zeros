export const DEPLOYMENT_MANIFEST_PATH: "/zeros-deployment.json";

export interface DeploymentManifest {
  version: 1;
  commitSha: string;
  surface: "app" | "ops";
}

export function createDeploymentManifest(
  commitSha: string,
  surface: "app" | "ops",
): DeploymentManifest;
