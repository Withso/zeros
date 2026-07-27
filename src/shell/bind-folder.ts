// ──────────────────────────────────────────────────────────
// bind-folder — shared "pick a folder and register it" helper
// ──────────────────────────────────────────────────────────
//
// Used by every surface that recovers from a chat / composer with no
// project folder bound (EmptyComposer's no-folder state, the
// NoFolderPanel shown in place of a folderless chat body). Mirrors
// Column 1's openProject minus the foreign-worktree adoption dialog —
// the caller only needs a usable cwd, and full adoption stays a Column-1
// concern. `pickProjectFolder` opens the native picker WITHOUT respawning
// the engine; we then register the folder as a Zeros project (`upsertProject`
// → `project.upsert` over the bridge) so the running engine serves it and git
// features light up — no kill / boot / reconnect.
//
// Returns the chosen repo-root path, or null when the user cancels (or
// the runtime isn't native).
// ──────────────────────────────────────────────────────────

import { pickProjectFolder } from "../native/native";
import { upsertProject } from "../zeros/store/projects-store";
import { notifyProjectsChanged } from "../zeros/store/use-projects";

export async function pickAndRegisterFolder(): Promise<string | null> {
  const root = await pickProjectFolder();
  if (!root) return null;
  upsertProject({ repoRoot: root });
  notifyProjectsChanged();
  return root;
}
