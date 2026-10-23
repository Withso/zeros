import { describe, expect, it, vi } from "vitest";
import type { Workspace } from "../../platform/git";
import type { ChatThread } from "../../state/store";
import type { OrganizationSummary } from "../../features/team/control-plane";
import { PERSONAL_ORGANIZATION } from "../../features/team/personal-organization";
import {
  actionPaletteEntries,
  chatPaletteEntries,
  filePaletteEntries,
  paletteCapabilities,
  paletteWorkspacesForOwner,
  selectPaletteEntries,
  settingsPaletteEntries,
  workspacePaletteEntries,
} from "../command-palette-model";

vi.mock("../../config/release-channel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/release-channel")>()),
  isFeatureEnabled: () => true,
}));

function workspace(id: string, overrides: Partial<Workspace> = {}): Workspace {
  return {
    id,
    repoSlug: "example/repo",
    repoRoot: "/repo",
    branch: id,
    baseBranch: "main",
    path: `/repo/${id}`,
    status: "in-progress",
    createdAt: 100,
    archivedAt: null,
    stashRef: null,
    prNumber: null,
    prState: null,
    prUrl: null,
    agentId: null,
    lastActiveAt: null,
    ...overrides,
  };
}
function organization(id: string): OrganizationSummary {
  return {
    ...PERSONAL_ORGANIZATION,
    id,
    isPersonal: false,
    workspaceCapabilities: { local: true, cloud: true },
  };
}
function chat(id: string, folder: string, updatedAt = 100): ChatThread {
  return {
    id,
    folder,
    title: id,
    agentId: null,
    agentName: null,
    model: null,
    effort: "medium",
    permissionMode: "auto",
    createdAt: 100,
    updatedAt,
  };
}
const local = workspace("local");
const orgLocal = workspace("org-local", {
  organizationId: "org-a",
  placement: "local",
});
const cloud = workspace("cloud", {
  organizationId: "org-a",
  placement: "cloud",
  path: "cloud://org-a/cloud",
  repoRoot: "cloud://org-a/cloud",
});
const foreign = workspace("foreign", {
  organizationId: "org-b",
  placement: "cloud",
  path: "cloud://org-b/foreign",
  repoRoot: "cloud://org-b/foreign",
});
const rows = [local, orgLocal, cloud, foreign];

describe("command palette owner isolation", () => {
  it("separates Local, organization-local and organization-cloud rows across A → B → A", () => {
    expect(
      paletteWorkspacesForOwner(rows, PERSONAL_ORGANIZATION, null),
    ).toEqual([local]);
    expect(
      paletteWorkspacesForOwner(rows, organization("org-a"), "org-a"),
    ).toEqual([orgLocal, cloud]);
    expect(
      paletteWorkspacesForOwner(rows, organization("org-b"), "org-b"),
    ).toEqual([foreign]);
    expect(
      paletteWorkspacesForOwner(rows, organization("org-a"), "org-a"),
    ).toEqual([orgLocal, cloud]);
  });

  it("keeps a cold known organization scoped while membership revalidates", () => {
    expect(paletteWorkspacesForOwner(rows, null, "org-a")).toEqual([
      orgLocal,
      cloud,
    ]);
    expect(paletteWorkspacesForOwner(rows, null, null)).toEqual([local]);
  });

  it("resolves nested workspace ownership before filtering chats", () => {
    const parent = workspace("parent", {
      path: "/repo",
      organizationId: "org-a",
    });
    const nested = workspace("nested", {
      path: "/repo/nested",
      organizationId: "org-b",
    });
    const chats = [
      chat("mine", "/repo/src"),
      chat("foreign", "/repo/nested/src"),
      chat("other", "/repository"),
    ];
    expect(
      chatPaletteEntries(chats, [parent], [parent, nested], 1_000).map(
        (entry) => entry.label,
      ),
    ).toEqual(["mine"]);
  });

  it("handles cloud identity and skips archived chats and Design-only workspaces", () => {
    const design = workspace("design", { kind: "design" });
    const chats = [
      chat("cloud chat", cloud.path),
      chat("foreign", foreign.path),
      { ...chat("archived", cloud.path), archived: true },
      chat("old design chat", design.path),
    ];
    const entries = chatPaletteEntries(
      chats,
      [cloud, design],
      [...rows, design],
      1_000,
    );
    expect(entries.map((entry) => entry.label)).toEqual(["cloud chat"]);
    expect(entries[0].target).toMatchObject({
      type: "chat",
      folder: cloud.path,
      workspace: cloud,
    });
  });

  it("separates active and archived/missing workspaces without duplicate destinations", () => {
    const archived = workspace("archived", { archivedAt: 50 });
    const missing = workspace("missing", { present: false });
    const data = [local, local, archived, missing];
    expect(
      workspacePaletteEntries(data, [], "active").map((entry) => entry.label),
    ).toEqual(["local"]);
    expect(workspacePaletteEntries(data, [], "archived")).toHaveLength(2);
    expect(workspacePaletteEntries(data, [], "all")).toHaveLength(3);
  });
});

const capabilityInput = {
  workspace: local,
  folder: local.path,
  onWorkspacePage: true,
  loading: false,
  localOwner: true,
  native: true,
  cloudCanEdit: true,
  createWorkspace: true,
  terminalAgents: false,
  activeFile: false,
  feedback: false,
};
describe("supported command availability", () => {
  it("offers local workspace tools but never disabled experimental or feedback actions", () => {
    const ids = actionPaletteEntries(paletteCapabilities(capabilityInput)).map(
      (entry) => entry.id,
    );
    expect(ids).toContain("action:browser");
    expect(ids).toContain("action:new-chat");
    expect(ids).not.toContain("action:new-terminal-agent");
    expect(ids).not.toContain("action:feedback");
  });

  it.each(["ready", "busy"])(
    "offers cloud code/files/terminal actions, with no Local-only tools: %s",
    (status) => {
      const capabilities = paletteCapabilities({
        ...capabilityInput,
        workspace: cloud,
        folder: cloud.path,
        localOwner: false,
        cloudStatus: status,
      });
      const ids = actionPaletteEntries(capabilities).map((entry) => entry.id);
      expect(ids).toContain("action:files");
      expect(ids).toContain("action:new-terminal");
      expect(ids).not.toContain("action:browser");
      expect(ids).not.toContain("action:reveal-folder");
      expect(ids).not.toContain("action:open-folder");
    },
  );

  it.each([
    undefined,
    "stopped",
    "archived",
    "failed",
    "provisioning",
    "waking",
    "stopping",
    "deleted",
  ])(
    "does not offer worker actions or file reads for an unavailable cloud workspace: %s",
    (status) => {
      const capabilities = paletteCapabilities({
        ...capabilityInput,
        workspace: cloud,
        folder: cloud.path,
        localOwner: false,
        cloudStatus: status,
      });
      expect(capabilities.workspace).toBe(false);
      expect(
        actionPaletteEntries(capabilities).some(
          (entry) => entry.group === "Workspace actions",
        ),
      ).toBe(false);
    },
  );

  it.each([
    { loading: true },
    { onWorkspacePage: false },
    { workspace: null },
    { workspace: { ...local, archivedAt: 100 } },
    { workspace: { ...local, present: false } },
    {
      workspace: cloud,
      folder: cloud.path,
      cloudStatus: "ready",
      cloudCanEdit: false,
    },
  ])(
    "withholds workspace commands without a current usable destination: %j",
    (change) => {
      expect(
        paletteCapabilities({ ...capabilityInput, ...change }).workspace,
      ).toBe(false);
    },
  );

  it("does not offer coding-chat actions in Design", () => {
    const capabilities = paletteCapabilities({
      ...capabilityInput,
      workspace: { ...local, kind: "design" },
    });
    expect(capabilities.codeWorkspace).toBe(false);
    expect(capabilities.workspace).toBe(true);
  });

  it("matches Settings visibility and never exposes Internal", () => {
    const context = {
      local: true,
      cloudEnabled: true,
      terminalAgentsEnabled: false,
      computerUseActive: false,
      simulatorsActive: false,
      internalUser: true,
    };
    const localIds = settingsPaletteEntries(context).map((entry) => entry.id);
    expect(localIds).toContain("settings:appearance");
    expect(localIds).not.toContain("settings:cloud-computer");
    expect(localIds).not.toContain("settings:internal");
    expect(localIds).not.toContain("settings:terminal-agents");
    const cloudIds = settingsPaletteEntries({ ...context, local: false }).map(
      (entry) => entry.id,
    );
    expect(cloudIds).toContain("settings:cloud-computer");
    expect(cloudIds).not.toContain("settings:environment");
  });
});

describe("command search", () => {
  it("keeps distinct literal paths selectable after cmdk trims item values", () => {
    const entries = filePaletteEntries(
      local.path,
      ["same.ts", "same.ts "],
      "same",
      [],
    );
    expect(new Set(entries.map((entry) => entry.id.trim())).size).toBe(2);
    expect(entries.map((entry) => entry.target)).toEqual([
      { type: "file", folder: local.path, path: "same.ts" },
      { type: "file", folder: local.path, path: "same.ts " },
    ]);
    const workspaces = workspacePaletteEntries(
      [workspace("folder:/repo/same"), workspace("folder:/repo/same ")],
      [],
      "active",
    );
    expect(new Set(workspaces.map((entry) => entry.id.trim())).size).toBe(2);
  });

  it("keeps literal filenames and exact workspace identity, prioritizes recent files and bounds results", () => {
    const paths = [
      " spaced file.ts ",
      "src/agent.tsx",
      ...Array.from({ length: 1_000 }, (_, i) => `src/file-${i}.ts`),
    ];
    const entries = filePaletteEntries(cloud.path, paths, "", [
      "src/agent.tsx",
      "deleted.ts",
    ]);
    expect(entries).toHaveLength(80);
    expect(entries[0].target).toEqual({
      type: "file",
      folder: cloud.path,
      path: "src/agent.tsx",
    });
    expect(entries[1].target).toMatchObject({ path: " spaced file.ts " });
    const matches = filePaletteEntries(local.path, paths, "agt", []);
    expect(matches.map((entry) => entry.label)).toEqual(["agent.tsx"]);
  });

  it("searches aliases and respects the active category", () => {
    const entries = [
      ...actionPaletteEntries(paletteCapabilities(capabilityInput)),
      ...settingsPaletteEntries({
        local: true,
        cloudEnabled: false,
        terminalAgentsEnabled: false,
        computerUseActive: false,
        simulatorsActive: false,
        internalUser: false,
      }),
    ];
    expect(
      selectPaletteEntries(entries, "settings", "font").map(
        (entry) => entry.id,
      ),
    ).toContain("settings:appearance");
    expect(selectPaletteEntries(entries, "actions", "font")).toEqual([]);
    expect(selectPaletteEntries(entries, "all", "zzzz-absent")).toEqual([]);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length);
  });

  it("bounds large chat/workspace lists before cmdk renders them", () => {
    const many = Array.from({ length: 1_000 }, (_, i) =>
      workspace(`branch-${i}`),
    );
    const entries = workspacePaletteEntries(many, [], "active");
    expect(selectPaletteEntries(entries, "all", "")).toHaveLength(5);
    expect(selectPaletteEntries(entries, "workspaces", "")).toHaveLength(100);
    expect(selectPaletteEntries(entries, "all", "branch")).toHaveLength(20);
  });
});
