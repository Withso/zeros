import { opSettingsRead, opSettingsWrite } from "./ops";
import { retiredAgentControlPatch } from "./retired-agent-control";

export { retiredAgentControlPatch };

/** Reads already fold retired keys; startup also rewrites the user file unless it is missing or malformed. */
export function migrateRetiredAgentControlSettings(): boolean {
  const read = opSettingsRead("user");
  if (read.error) return false;
  const patch = retiredAgentControlPatch(read.doc);
  if (!patch) return false;
  opSettingsWrite("user", patch);
  return true;
}
