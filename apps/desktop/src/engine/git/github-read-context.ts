import { AsyncLocalStorage } from "node:async_hooks";

const context = new AsyncLocalStorage<{ fetch: typeof fetch; authorized: () => boolean; canEdit: boolean }>();
export function runWithGithubReadTransport<T>(requestFetch: typeof fetch, authorized: () => boolean, run: () => T, canEdit = false): T {
  return context.run({ fetch: requestFetch, authorized, canEdit }, run);
}
/** Installation viewer permissions do not describe the human courier. This
 * is a UI hint only: each write still requires its exact user's grant. */
export function githubReadCanEdit(): boolean | undefined { return context.getStore()?.canEdit; }
export function githubReadTransport(): typeof fetch | undefined {
  const scope = context.getStore();
  if (!scope) return undefined;
  if (!scope.authorized()) throw new Error("GitHub read authorization is unavailable. Reconnect the workspace and try again.");
  return async (input, init) => {
    if (!scope.authorized()) throw new Error("GitHub read authorization is unavailable.");
    const response = await scope.fetch(input, init);
    if (!scope.authorized()) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("GitHub read authorization is unavailable.");
    }
    return response;
  };
}
