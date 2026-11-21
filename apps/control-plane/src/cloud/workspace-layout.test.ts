import { describe, expect, it } from "vitest";
import { projectFolderName, repositoryFolderNames, workspaceCheckoutPath, workspaceRootPath } from "./workspace-layout.js";
import { hydrateCloudRepository } from "./source-authority.js";
import type { CloudV2Workspace } from "./store.js";

describe("a workspace's folders", () => {
  it("derives a project folder of safe characters, never a dotfile, a reserved home entry or empty", () => {
    expect(projectFolderName("Zeros App")).toBe("zeros-app");
    expect(projectFolderName("Café / Résumé v2")).toBe("cafe-resume-v2");
    expect(projectFolderName("  ..hidden  ")).toBe("hidden");
    expect(projectFolderName(".env")).toBe("env");
    expect(projectFolderName("草")).toBe("project");
    expect(projectFolderName("---")).toBe("project");
    expect(projectFolderName("node_modules")).toBe("node_modules-project");
    expect(projectFolderName("Go")).toBe("go-project");
    expect(projectFolderName("a".repeat(80) + ".")).toBe("a".repeat(64));
    expect(projectFolderName("x".repeat(63) + "-.y")).toBe("x".repeat(63));
    // Every derived folder satisfies the database check.
    for (const name of ["Zeros", "a.b", "1st", "end.", "-x-", "Ünïcødé"])
      expect(projectFolderName(name)).toMatch(/^[a-z0-9][a-z0-9._-]{0,63}$/);
  });

  it("names each repository's folder after it, and a later one of the same name after its owner too", () => {
    expect(repositoryFolderNames(["withso/zeros", "withso/web"])).toEqual(["zeros", "web"]);
    expect(repositoryFolderNames(["withso/api", "acme/api", "beta/API"])).toEqual(["api", "api-acme", "API-beta"]);
    expect(repositoryFolderNames(["withso/.git", "withso/.github"])).toEqual(["repo-git", ".github"]);
  });

  it("keeps a workspace made before projects at /home/user/<repository>", () => {
    expect(workspaceCheckoutPath({ repository: "Withso/Zeros" })).toBe("/home/user/Withso/Zeros");
    expect(workspaceRootPath({ repository: "Withso/Zeros" })).toBe("/home/user/Withso/Zeros");
    const several = { repository: "withso/zeros-renamed", folder: "zeros-app", checkoutFolder: "zeros-app/zeros" };
    expect(workspaceCheckoutPath(several)).toBe("/home/user/zeros-app/zeros");
    expect(workspaceRootPath(several)).toBe("/home/user/zeros-app");
    // One repository: the agent works in its own folder inside the project folder.
    const one = { repository: "withso/zeros", checkoutFolder: "zeros-app/zeros" };
    expect(workspaceRootPath(one)).toBe("/home/user/zeros-app/zeros");
    const project = several;
    // Released desktops parse the first checkout as /home/user/<a>/<b>.
    expect(workspaceCheckoutPath(project)).toMatch(/^\/home\/user\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  });

  it("clones each repository into its own folder of the project folder, and older workspaces as before", () => {
    const workspace = { repository: "withso/web", checkoutFolder: "zeros-app/web" } as CloudV2Workspace;
    expect(hydrateCloudRepository(workspace)).toContain("'\\''/home/user/zeros-app/web'\\''");
    expect(hydrateCloudRepository({ repository: "withso/web" } as CloudV2Workspace)).toContain("'\\''/home/user/withso/web'\\''");
  });
});
