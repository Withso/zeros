import { getSetting, setSetting } from "../platform/settings";
import { parseCloudWorkspaceKey } from "../platform/bridge/cloud-workspace-key";
import {
  beginWorkspaceModeSwitch,
  finishWorkspaceModeSwitch,
} from "./pending-workspaces";

const KEY = "cloud-design-creation:v1";
let owner: string | null = null;
const intents = new Map<string, string>();

function persist(): void {
  if (owner) setSetting(KEY, { owner, folders: [...intents.keys()] });
}

/** A Design create finishes only after the worker is ready. Keep that intent
 * through navigation/reload, separate from its confirmed workspace mode. */
export function setCloudCreationModeOwner(next: string | null): void {
  for (const [folder, token] of intents)
    finishWorkspaceModeSwitch(folder, token);
  intents.clear();
  owner = next;
  if (!next) return;
  const saved = getSetting<{ owner?: unknown; folders?: unknown } | null>(
    KEY,
    null,
  );
  if (saved?.owner !== next || !Array.isArray(saved.folders)) return;
  for (const folder of saved.folders.slice(-64)) {
    try {
      if (
        typeof folder === "string" &&
        parseCloudWorkspaceKey(folder)?.relativePath === ""
      )
        intents.set(folder, beginWorkspaceModeSwitch(folder, "design"));
    } catch {
      /* A corrupt device hint cannot acquire a different owner. */
    }
  }
}

export function registerCloudDesignCreation(folder: string): void {
  if (!owner || !parseCloudWorkspaceKey(folder))
    throw new Error("Sign in before creating a cloud Design workspace");
  if (intents.size >= 64)
    throw new Error("Finish the pending cloud workspace creations first");
  intents.set(folder, beginWorkspaceModeSwitch(folder, "design"));
  persist();
}

export const pendingCloudDesignCreations = () => [...intents.entries()];
export function finishCloudDesignCreation(folder: string, token: string): void {
  if (intents.get(folder) !== token) return;
  intents.delete(folder);
  persist();
  finishWorkspaceModeSwitch(folder, token);
}
