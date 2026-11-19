import fs from "node:fs";
import path from "node:path";
import type { Channel } from "../src/engine/runtime";
import { isCheckoutInstanceId } from "../src/engine/db/local-development-paths.cjs";

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

/** Account-free Local runs only on a checkout's own id, and hosted
 * development never on one, so the two can never open one profile and its
 * store. Checked before any storage is selected. */
export function assertDevelopmentAdmission(input: {
  localDevelopment: boolean;
  instance: string | null;
}): void {
  if (input.localDevelopment && !(input.instance && isCheckoutInstanceId(input.instance)))
    throw new Error(
      `[Zeros] Zeros Local runs only on a checkout's own instance, not "${input.instance ?? ""}". Launch it with pnpm electron:local.`,
    );
  if (!input.localDevelopment && input.instance && isCheckoutInstanceId(input.instance))
    throw new Error(
      `[Zeros] "${input.instance}" is a Zeros Local checkout id; a hosted development process cannot use it.`,
    );
}

// Names a development or retired profile takes beside the real roots: legacy
// Local `com.zeros.local.<inst>` / `zeros-local-<inst>` and the retired Zeros
// Dev desktop's `com.zeros.dev[.<x>]` / `zeros-dev[-<x>]`.
const PROFILE_SIBLING = /^(?:com\.zeros\.(?:local|dev)(?:\.|$)|zeros-(?:local|dev)(?:-|$))/;

/** The physical path, resolving every existing ancestor's links. */
function physical(target: string): string {
  const absolute = path.resolve(target);
  const rest: string[] = [];
  let cursor = absolute;
  for (;;) {
    try {
      return path.join(fs.realpathSync(cursor), ...rest.reverse());
    } catch {
      const parent = path.dirname(cursor);
      if (parent === cursor) return absolute;
      rest.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

/** A development ZEROS_DATA_DIR isolates a fixture: it must not physically be,
 * contain or sit inside any real profile, including legacy Local and retired
 * Dev siblings in `appData`, or it would select that profile's store. */
export function assertDevelopmentOverrideIsolated(
  override: string | undefined,
  input: { profileRoots: readonly string[]; appData: string },
): void {
  const value = override?.trim();
  if (!value) return;
  const roots = [...input.profileRoots];
  try {
    for (const name of fs.readdirSync(input.appData))
      if (PROFILE_SIBLING.test(name)) roots.push(path.join(input.appData, name));
  } catch {
    /* no app-data folder: no sibling profiles */
  }
  const target = physical(value);
  const overlaps = (a: string, b: string) => a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`);
  for (const root of roots)
    if (overlaps(target, physical(root)) || overlaps(path.resolve(value), path.resolve(root)))
      throw new Error("[Zeros] ZEROS_DATA_DIR resolves to or around a real Zeros profile. Use a separate fixture folder.");
}
