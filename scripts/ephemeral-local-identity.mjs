// One owner for every identity a test or qualification script mints. It is
// registered as `ephemeral` with this process as owner, and its roots are
// removed on dispose, exit and termination signals. If the process is killed
// outright, the next launcher prune removes it once the owner PID is dead.
import os from "node:os";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { registryPath, removeInstance, upsertInstance } from "./local-instance-registry.mjs";
import { identityTargets, removeTargets } from "./local-instance-prune.mjs";

const require = createRequire(import.meta.url);
const paths = require("../apps/desktop/src/engine/db/local-development-paths.cjs");

const PURPOSE = /^[a-z][a-z0-9-]{1,23}$/;
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

export function createEphemeralIdentity({
  purpose,
  name,
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
  random = () => randomUUID().replace(/-/g, "").slice(0, 12),
  handleProcessExit = true,
}) {
  if (!PURPOSE.test(purpose ?? "")) throw new Error("Invalid ephemeral identity purpose");
  const slug = `${purpose}-${random()}`;
  if (paths.isReservedInstanceId(slug)) throw new Error("Invalid ephemeral identity");
  const roots = paths.developmentPaths({ instance: slug, home, platform, env });
  const containers = paths.developmentContainers({ home, platform, env });
  const file = registryPath({ home, platform, env });
  upsertInstance(file, slug, { kind: "ephemeral", name, checkout: null, layout: "v2", ownerPid: process.pid });
  let disposed = false;
  const handlers = new Map();
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    process.off("exit", dispose);
    for (const [signal, handler] of handlers) process.off(signal, handler);
    try {
      removeTargets(identityTargets(roots, containers), { home });
      removeInstance(file, slug);
    } catch {
      // The registry entry still names this dead owner; the next prune retries.
    }
  };
  if (handleProcessExit) {
    process.once("exit", dispose);
    for (const signal of SIGNALS) {
      // A script with its own handler shuts its app down first and disposes in
      // its finally (or on exit); removing roots now would race that shutdown.
      const handler = () => {
        if (process.listenerCount(signal) !== 1) return;
        dispose();
        process.kill(process.pid, signal);
      };
      handlers.set(signal, handler);
      process.on(signal, handler);
    }
  }
  return { slug, name, roots, dispose };
}
