import { loadCloudWorkerConfiguration } from "../agents/containment/cloud-worker-config";
import { stripEngineAuthorityEnv } from "../agents/adapters/shared/config-isolation";

type GitIdentity = { uid: number; gid: number };
let deploymentGitIdentity: Readonly<GitIdentity> | null | undefined;

/** Leaf boundary shared by asynchronous operations and synchronous probes.
 * Do not import the credential broker or settings here: settings use Git too. */
export function gitExecutionIdentity(explicit?: GitIdentity): GitIdentity | undefined {
  if (deploymentGitIdentity === undefined) {
    const worker = loadCloudWorkerConfiguration();
    deploymentGitIdentity = worker
      ? Object.freeze({ uid: worker.uid, gid: worker.gid })
      : null;
  }
  if (!deploymentGitIdentity) return explicit;
  if (explicit && (explicit.uid !== deploymentGitIdentity.uid || explicit.gid !== deploymentGitIdentity.gid))
    throw new Error("Managed cloud Git requires the qualified worker identity");
  return deploymentGitIdentity;
}

export function gitProcessOptions(
  env: NodeJS.ProcessEnv = process.env,
  explicit?: GitIdentity,
): { uid?: number; gid?: number; env: NodeJS.ProcessEnv } {
  const identity = gitExecutionIdentity(explicit);
  return {
    ...identity,
    env: deploymentGitIdentity
      ? stripEngineAuthorityEnv(Object.fromEntries(Object.entries(env).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        )))
      : env,
  };
}
