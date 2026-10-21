import { withoutLocalDevelopment } from "../env/local-development";

type GitIdentity = { uid: number; gid: number };

/** Leaf boundary shared by asynchronous operations and synchronous probes.
 * Do not import the credential broker or settings here: settings use Git too. */
export function gitExecutionIdentity(explicit?: GitIdentity): GitIdentity | undefined {
  return explicit;
}

export function gitProcessOptions(
  env: NodeJS.ProcessEnv = process.env,
  explicit?: GitIdentity,
): { uid?: number; gid?: number; env: NodeJS.ProcessEnv } {
  const identity = gitExecutionIdentity(explicit);
  return {
    ...identity,
    env: withoutLocalDevelopment(env),
  };
}
