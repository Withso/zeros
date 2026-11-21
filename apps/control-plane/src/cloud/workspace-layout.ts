// Where a cloud workspace's repositories live on its VM (owner decision, P2).
//
// A workspace of a project has one folder named after the project, fixed when
// the workspace is created: /home/user/<project-folder>, with each repository
// in its own folder inside it: /home/user/<project-folder>/<repository-folder>.
// Renaming the project changes the folder of new workspaces only. A workspace
// made before projects keeps /home/user/<owner>/<name> (no folder).
//
// The agent works in the project folder when the project has several
// repositories and in the repository's own folder when it has one. The first
// repository's checkout is always /home/user/<a>/<b>, the shape released
// desktops parse, so they open a workspace of several repositories on its first.

/** Home entries tools and install scripts commonly own; a project folder never takes one. */
const RESERVED = new Set(["bin", "go", "lib", "node_modules", "opt", "snap", "tmp"]);
export const PROJECT_FOLDER_MAX = 64;

/**
 * The project folder for a project name: ASCII letters and digits lowercased,
 * accents dropped, every other run of characters one "-", no leading or
 * trailing "-" or "." (so never a dotfile), at most 64 characters. A name that
 * leaves nothing becomes "project"; a reserved name gets "-project". Two
 * projects may derive the same folder: a VM holds one workspace, so folders
 * never meet on a disk.
 */
export function projectFolderName(name: string): string {
  const base = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-").replace(/-{2,}/g, "-").replace(/^[-.]+/, "")
    .slice(0, PROJECT_FOLDER_MAX).replace(/[-.]+$/, "");
  const folder = /^[a-z0-9]/.test(base) ? base : "project";
  return RESERVED.has(folder) ? `${folder}-project` : folder;
}

/**
 * Each repository's folder inside the project folder, in position order: its
 * name. A later repository whose name an earlier one already took (the same
 * name from another owner) gets "<name>-<owner>", then a number. GitHub names
 * already use only safe characters; ".", ".." and ".git" never stand alone.
 */
export function repositoryFolderNames(repositories: readonly string[]): string[] {
  const taken = new Set<string>();
  return repositories.map(repository => {
    const [owner, name] = repository.split("/") as [string, string];
    const safe = (value: string) => [".", "..", ".git"].includes(value) ? `repo-${value.replace(/^\.+/, "") || "dot"}` : value;
    const candidates = [safe(name), safe(`${name}-${owner}`)].map(value => value.slice(0, 100));
    let folder = candidates.find(candidate => !taken.has(candidate.toLowerCase()));
    for (let index = 2; !folder; index++) {
      const numbered = `${candidates[1]!.slice(0, 96)}-${index}`;
      if (!taken.has(numbered.toLowerCase())) folder = numbered;
    }
    taken.add(folder.toLowerCase());
    return folder;
  });
}

export const CLOUD_V2_HOME_PATH = "/home/user";

export type WorkspaceLayoutFields = { repository: string; folder?: string | null | undefined; checkoutFolder?: string | null | undefined };

/** The first repository's checkout: today's /home/user/<repository> for a workspace made before projects. */
export function workspaceCheckoutPath(workspace: WorkspaceLayoutFields): string {
  return `${CLOUD_V2_HOME_PATH}/${workspace.checkoutFolder ?? workspace.repository}`;
}

/** Where the agent works and every workspace path is relative to: the project
 * folder for several repositories, else the one checkout. */
export function workspaceRootPath(workspace: WorkspaceLayoutFields): string {
  return workspace.folder ? `${CLOUD_V2_HOME_PATH}/${workspace.folder}` : workspaceCheckoutPath(workspace);
}
