import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { developmentHome } from "./state.mjs";

export const PROFILE_NAME = "zeros-dev-env.json";

// lstat deliberately counts dangling links as present. A broken or unsafe
// preferred profile must fail, never silently select another set of credentials.
export function profileExists(file) {
  try { fs.lstatSync(file); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

export function developmentProfilePath(root, { env = process.env, homeDir = os.homedir() } = {}) {
  if (env.ZEROS_DEV_PROFILE_PATH) return path.resolve(env.ZEROS_DEV_PROFILE_PATH);
  const directory = path.join(homeDir, ".zeros-dev");
  const candidates = [
    ...(root ? [path.join(root, PROFILE_NAME), path.join(root, ".env.zeros-dev.json")] : []),
    path.join(directory, PROFILE_NAME), path.join(directory, "development.json"),
  ];
  const file = candidates.find(profileExists) ?? path.join(directory, PROFILE_NAME);
  if (path.dirname(file) === directory && profileExists(file)) developmentHome(homeDir);
  return file;
}
