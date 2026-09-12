import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { zerosDataDir } from "../db/paths";
import { writeSettingsFileRaw } from "./files";
import {
  migrateWorkspaceSettings,
  ensureLocalSettingsIgnored,
  initializeWorkspaceSettings,
} from "./personal-repo";

function backupPath(workspaceId: string): string {
  const name = createHash("sha256").update(workspaceId).digest("hex");
  return path.join(zerosDataDir(), "workspace-settings", `${name}.toml`);
}

/** Private archive companion, outside Git and any shared repository. Keep
 * exact bytes (including invalid TOML) so archiving never discards editor work. */
export function backupWorkspaceSettings(
  workspaceId: string,
  root: string,
): void {
  if (!existsSync(root)) return; // retain the pre-hook recovery copy
  const source = migrateWorkspaceSettings(root);
  ensureLocalSettingsIgnored(
    root,
    `.zeros/${path.basename(source)}` as
      | ".zeros/settings.toml"
      | ".zeros/settings.local.toml",
  );
  if (existsSync(source))
    writeSettingsFileRaw(backupPath(workspaceId), readFileSync(source, "utf8"));
  else removeWorkspaceSettingsBackup(workspaceId);
}

export function restoreWorkspaceSettings(
  workspaceId: string,
  root: string,
): void {
  const target = migrateWorkspaceSettings(root);
  ensureLocalSettingsIgnored(
    root,
    `.zeros/${path.basename(target)}` as
      | ".zeros/settings.toml"
      | ".zeros/settings.local.toml",
  );
  const source = backupPath(workspaceId);
  // A resumed restore may already have published the file. Keep any edit made
  // after that publication; the archive copy remains available until deletion.
  if (existsSync(source) && !existsSync(target))
    writeSettingsFileRaw(target, readFileSync(source, "utf8"));
  else if (!existsSync(target)) initializeWorkspaceSettings(root);
}

export function removeWorkspaceSettingsBackup(workspaceId: string): void {
  rmSync(backupPath(workspaceId), { force: true });
}
