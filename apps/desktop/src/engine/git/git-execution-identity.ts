import { loadCloudWorkerConfiguration } from "../agents/containment/cloud-worker-config";
import { stripEngineAuthorityEnv } from "../agents/adapters/shared/config-isolation";
import { withoutLocalDevelopment } from "../env/local-development";

type GitIdentity = { uid: number; gid: number };
let deploymentGitIdentity: Readonly<GitIdentity> | null | undefined;

/** Leaf boundary shared by asynchronous operations and synchronous probes.
 * Do not import the credential broker or settings here: settings use Git too. */
export function gitExecutionIdentity(explicit?: GitIdentity): GitIdentity | undefined {
  if (deploymentGitIdentity === undefined) {
    const worker = loadCloudWorkerConfiguration();
    // The verified marker establishes cloud placement. New Git processes use
    // the actual non-root engine identity, never archived worker accounts.
    deploymentGitIdentity = worker
      ? Object.freeze({ uid: process.geteuid!(), gid: process.getegid!() })
      : null;
  }
  if (!deploymentGitIdentity) return explicit;
  if (explicit && (explicit.uid !== deploymentGitIdentity.uid || explicit.gid !== deploymentGitIdentity.gid))
    throw new Error("Managed cloud Git requires the engine identity");
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
      : withoutLocalDevelopment(env),
  };
}
