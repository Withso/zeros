import type { Channel } from "../src/engine/runtime";
import { isReservedInstanceId } from "../src/engine/db/local-development-paths.cjs";

/** Where secret-store.ts keeps secrets.json; undefined means this identity's
 * own userData. Account-free Local shares the family's provider store across
 * checkouts. Hosted development identities share the `alpha` instance's
 * account store, which therefore stays in that instance and is never Local's.
 * `alpha` names its own dir explicitly: a shared store is what enables the Dev
 * callback relay (workos-auth.ts). ZEROS_ISOLATE=1 keeps any development
 * identity's secrets private. */
export function sharedSecretsDirectory(input: {
  channel: Channel;
  localDevelopment: boolean;
  isolate: boolean;
  familyDataDir: string;
  hostedAccountDataDir: string;
}): string | undefined {
  if (input.channel !== "dev" || input.isolate) return undefined;
  if (input.localDevelopment) return input.familyDataDir;
  return input.hostedAccountDataDir;
}

/** `alpha` and `default` are hosted identities; account-free admission on one
 * would open its account store and data. */
export function assertDevelopmentAdmission(input: {
  localDevelopment: boolean;
  instance: string | null;
}): void {
  if (input.localDevelopment && input.instance && isReservedInstanceId(input.instance))
    throw new Error(
      `[Zeros] Zeros Local cannot use the reserved instance "${input.instance}". Launch it with pnpm electron:local.`,
    );
}
