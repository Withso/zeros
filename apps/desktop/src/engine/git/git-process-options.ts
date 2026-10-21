import { withoutLocalDevelopment } from "../env/local-development";

/** Leaf boundary shared by asynchronous operations and synchronous probes.
 * Do not import the credential broker or settings here: settings use Git too. */
export function gitProcessOptions(env: NodeJS.ProcessEnv = process.env): { env: NodeJS.ProcessEnv } {
  return { env: withoutLocalDevelopment(env) };
}
