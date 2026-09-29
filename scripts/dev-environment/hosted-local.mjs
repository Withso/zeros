import fs from "node:fs";
import path from "node:path";
import { acquireWorkspaceLock } from "./state.mjs";

/** Remote archive can run from either machine. A local desktop may still own
 * SQLite files; leave them intact until it has exited. A fresh generation uses
 * another directory and cannot inherit the archived session. */
export function cleanupHostedLocalState(directory, state, { locked = false } = {}) {
  let release;
  try { if (!locked) release = acquireWorkspaceLock({ directory, state }); }
  catch (error) { if (error.code === "DEV_ALREADY_RUNNING") return false; throw error; }
  try {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(state.generation ?? "")) throw new Error("Local cleanup requires an exact archived generation");
    for (const parts of [[`desktop-${state.generation}`], ["images", state.generation], ["generations", state.generation]]) {
      let file = directory;
      for (const part of parts) {
        file = path.join(file, part);
        if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error("Refusing a linked Dev local cleanup directory");
      }
      fs.rmSync(file, { recursive: true, force: true });
    }
    return true;
  } finally { release?.(); }
}
