// One owner for every identity a test or qualification script mints. It is
// registered as `ephemeral` with this process as owner. The helper owns no
// signals and no exit hook: the script keeps sole control of shutdown and calls
// dispose({ retired }) once it knows whether its app and engine have exited.
// Roots are removed only after retirement; anything not removed stays
// registered, and the launcher prune removes it once this owner is dead.
import os from "node:os";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { registryPath, removeInstance, upsertInstance } from "./local-instance-registry.mjs";
import { identityTargets, removeTargets } from "./local-instance-prune.mjs";
import { refusal } from "./storage-removal.mjs";

const require = createRequire(import.meta.url);
const paths = require("../apps/desktop/src/engine/db/local-development-paths.cjs");

const PURPOSE = /^[a-z][a-z0-9-]{1,23}$/;

export function createEphemeralIdentity({
  purpose,
  name,
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
  random = () => randomUUID().replace(/-/g, "").slice(0, 12),
}) {
  if (!PURPOSE.test(purpose ?? "")) throw new Error("Invalid ephemeral identity purpose");
  const slug = `${purpose}-${random()}`;
  if (paths.isReservedInstanceId(slug)) throw new Error("Invalid ephemeral identity");
  const roots = paths.developmentPaths({ instance: slug, home, platform, env });
  const containers = paths.developmentContainers({ home, platform, env });
  const file = registryPath({ home, platform, env });
  upsertInstance(file, slug, { kind: "ephemeral", name, checkout: null, layout: "v2", ownerPid: process.pid });
  // A `--reference-root` build of an older checkout uses the flat layout for
  // the same slug; it is this identity's too.
  const targets = [
    ...identityTargets(roots, containers),
    ...identityTargets(paths.developmentPaths({ instance: slug, layout: "legacy", home, platform, env }), containers),
  ];
  let disposed = false;
  const dispose = ({ retired } = {}) => {
    if (disposed || retired !== true) return false;
    removeTargets(targets, { home });
    const remaining = targets.some((target) => refusal(target.target, { container: target.container, home, kind: target.file ? "file" : "directory" }) !== "missing");
    if (remaining) return false;
    disposed = true;
    try {
      removeInstance(file, slug);
    } catch {
      // Still registered with a dead owner: the next prune retries.
    }
    return true;
  };
  return { slug, name, roots, dispose };
}
