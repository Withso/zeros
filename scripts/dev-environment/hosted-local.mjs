import fs from "node:fs";
import path from "node:path";
import { acquireWorkspaceLock } from "./state.mjs";

/** Remote archive can run from either machine. A local desktop may still own
 * SQLite files; leave them intact until it has exited. A fresh generation uses
 * another directory and cannot inherit the archived session. */
export function cleanupHostedLocalState(directory, state) {
  let release;
  try { release = acquireWorkspaceLock({ directory, state }); }
  catch (error) { if (error.code === "DEV_ALREADY_RUNNING") return false; throw error; }
  try {
    for (const name of fs.readdirSync(directory)) {
      if (name === "run.lock") continue;
      const file = path.join(directory, name);
      if (fs.lstatSync(file).isSymbolicLink()) throw new Error("Refusing a linked Dev local cleanup directory");
      fs.rmSync(file, { recursive: true, force: true });
    }
    return true;
  } finally { release(); }
}
