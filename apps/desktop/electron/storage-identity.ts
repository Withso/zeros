import fs from "node:fs";
import path from "node:path";
import { isCheckoutInstanceId } from "../src/engine/db/local-development-paths.cjs";

/** Account-free Local runs only on a checkout's own id: its storage namespace
 * (`com.zeros.local`) then holds nothing but Local checkouts. Checked before
 * any storage is selected. */
export function assertLocalAdmission(instance: string): void {
  if (!isCheckoutInstanceId(instance))
    throw new Error(
      `[Zeros] Zeros Local runs only on a checkout's own instance, not "${instance}". Launch it with pnpm electron:local.`,
    );
}

// Names a per-instance profile takes beside the real roots: legacy Local
// `com.zeros.local.<inst>` / `zeros-local-<inst>` and hosted Dev
// `com.zeros.dev.<slug>` / `zeros-dev-<slug>`.
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

/** A Local ZEROS_DATA_DIR isolates a fixture: it must not physically be,
 * contain or sit inside any real profile, including per-instance Local and Dev
 * siblings in `appData`, or it would select that profile's store. */
export function assertLocalOverrideIsolated(
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
