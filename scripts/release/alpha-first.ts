// Alpha is the stage that runs a release's migrations first: a release is cut
// from main, so Alpha has already applied every migration the release carries
// unless its own deploy is behind. Production hosted promotion, Apple submission
// and controlled cutovers require Alpha's live identity to show it.
import { CHANNELS, ReleaseIdentity, requireCheck } from "./contracts";
import { jsonClient } from "./io";

/** Alpha's anonymous live identity. Its origin comes from ./contracts, not ./runtime-contracts: release jobs install
 * only the root workspace, and runtime-contracts loads control-plane modules that need `pg` (import-graph.test.ts). */
export const alphaIdentity = (fetcher: typeof fetch = fetch) => () =>
  jsonClient(fetcher)(`${CHANNELS.alpha.api}/v1/release-identity`, { cache: "no-store" });

const number = (name: string) => Number(/^(\d{4})_/.exec(name)?.[1] ?? NaN);

/** Refuse unless Alpha is ready and has applied every named migration. */
export async function requireAlphaRanFirst(migrations: readonly string[], identity: () => Promise<unknown>): Promise<string> {
  requireCheck(migrations.length > 0 && migrations.every(name => Number.isInteger(number(name))), "Migrations to check against Alpha are invalid");
  let parsed;
  try { parsed = ReleaseIdentity.safeParse(await identity()); } catch { parsed = null; }
  requireCheck(parsed?.success && parsed.data.channel === "alpha",
    "Alpha is unavailable or not ready; Production waits for Alpha to run this release's migrations first");
  const head = parsed.data.migrations.head;
  for (const name of migrations)
    requireCheck(number(name) < number(head) || name === head,
      `Alpha has not run ${name} yet (Alpha is at ${head}); let Alpha deploy it before Production`);
  return head;
}
