// Remove the retired browser and computer-use keys from the user's settings
// file once at engine start. Reading already folds them into their
// replacements in every layer (retired-agent-control.ts); this keeps the file
// matching Settings.

import { opSettingsRead, opSettingsWrite } from "./ops";
import { retiredAgentControlPatch } from "./retired-agent-control";

export { retiredAgentControlPatch };

/** Retire the old keys in the user's settings file. Idempotent; a missing or
 * malformed file is left alone (its errors already surface in Settings). */
export function migrateRetiredAgentControlSettings(): boolean {
  const read = opSettingsRead("user");
  if (read.error) return false;
  const patch = retiredAgentControlPatch(read.doc);
  if (!patch) return false;
  opSettingsWrite("user", patch);
  return true;
}
