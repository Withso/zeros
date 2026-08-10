import { describe, expect, it } from "vitest";

import {
  dbChangedIncludesOriginator,
  dbChangedKinds,
  LONG_LIFECYCLE_OPS,
} from "../change-events";

describe("dbChangedKinds", () => {
  it.each([
    "chats.upsert",
    "chats.delete",
    "chats.bulkUpsert",
    "chats.clearProviderIdentity",
  ])("classifies %s as chat server state", (op) => {
    expect(dbChangedKinds(op)).toEqual(["chats"]);
  });

  it.each([
    "project.upsert",
    "project.remove",
    "project.rename",
    "project.bulkUpsert",
  ])("classifies %s as project server state", (op) => {
    expect(dbChangedKinds(op)).toEqual(["projects"]);
  });

  it.each(["settings.write", "settings.writeRaw", "settings.migrateLegacy"])(
    "classifies %s as settings server state",
    (op) => {
      expect(dbChangedKinds(op)).toEqual(["settings"]);
    },
  );

  it.each([
    "workspace.setRemoteRestricted",
    "workspace.reassignLocalOrganization",
    "workspace.archive",
    "workspace.delete",
    "workspace.createFromBranch",
    "workspace.adoptExisting",
    "workspace.proposeBranchName",
    "design.frame.create",
    "design.frame.rename",
    "design.frame.duplicate",
    "design.frame.delete",
    "design.canvas.update",
    "design.node.styles",
    "design.node.text",
    "design.node.html",
    "design.asset.insert",
    "design.token.update",
    "design.save",
    "git.fetch",
    "git.reset",
    "git.merge",
    "git.stageHunk",
    "git.tagCreate",
    "git.initInPlace",
    "gh.publishRepo",
    "detach.start",
    "detach.stop",
  ])("classifies previously uncovered mutation %s as workspace state", (op) => {
    expect(dbChangedKinds(op)).toEqual(["workspaces"]);
  });

  it("publishes both workspace and chat state when restore can rebind folders", () => {
    expect(dbChangedKinds("workspace.restore")).toEqual([
      "workspaces",
      "chats",
    ]);
  });

  it("publishes gh.prSync only when the detector persisted a PR", () => {
    expect(dbChangedKinds("gh.prSync", null)).toBeNull();
    expect(dbChangedKinds("gh.prSync", { number: 191 })).toEqual([
      "workspaces",
    ]);
  });

  it("publishes ownership repair only when local rows moved, including to the originator", () => {
    expect(
      dbChangedKinds("workspace.reassignLocalOrganization", { changes: 0 }),
    ).toBeNull();
    expect(
      dbChangedKinds("workspace.reassignLocalOrganization", { changes: 2 }),
    ).toEqual(["workspaces"]);
    expect(
      dbChangedIncludesOriginator("workspace.reassignLocalOrganization"),
    ).toBe(true);
  });

  it.each([
    "workspace.list",
    "file.read",
    "git.status",
    "git.diff",
    "gh.prGet",
    "turns.list",
    "settings.read",
  ])("does not broadcast for read %s", (op) => {
    expect(dbChangedKinds(op)).toBeNull();
  });

  it.each([
    "workspace.create",
    "workspace.createFromBranch",
    "workspace.restore",
    "workspace.archive",
    "workspace.continueOnNewBranch",
    // Network-bound git/GitHub writes: a slow remote or the GitHub API can
    // outlive even the renderer's raised 60s budget. gh.prMerge was the
    // motivating bug — a slow merge SUCCEEDED on GitHub but the originator saw
    // "Couldn't merge PR" and a stale card because the completion broadcast
    // excluded it.
    "git.push",
    "git.pull",
    "git.fetch",
    "git.rebase",
    "gh.prCreate",
    "gh.prMarkReady",
    "gh.prMerge",
  ])(
    "long lifecycle op %s broadcasts DB_CHANGED to the originator too",
    (op) => {
      // These RPCs can outlive the renderer's request budget; the originator's
      // promise may already have rejected, so the broadcast must include it.
      expect(LONG_LIFECYCLE_OPS.has(op)).toBe(true);
      // Sanity: every long lifecycle op is also a workspace mutation.
      expect(dbChangedKinds(op)).toContain("workspaces");
    },
  );

  it.each(["git.commit", "git.stage", "gh.prUpdate", "gh.prComment"])(
    "local / fast op %s keeps the originator-excluding broadcast",
    (op) => {
      expect(LONG_LIFECYCLE_OPS.has(op)).toBe(false);
    },
  );

  it("keeps LONG_LIFECYCLE_OPS a strict subset of workspace mutations", () => {
    for (const op of LONG_LIFECYCLE_OPS) {
      expect(dbChangedKinds(op)).toContain("workspaces");
    }
  });
});

describe("dbChangedIncludesOriginator", () => {
  it.each(["settings.write", "settings.writeRaw", "settings.migrateLegacy"])(
    "echoes %s back to the client that wrote it",
    (op) => {
      // The writer keeps its own LAYER document (the write result carries it)
      // but NOT the RESOLVED tree, which the engine merges from four layers and
      // no response describes. Without the echo, the writer's own
      // useResolvedSettings stayed stale until the settings file-watcher's 3s
      // poll broadcast to everyone — which is what made Settings → Git read as
      // a frozen pane: its radio renders `checked` off that tree, so a click
      // did nothing at all for three seconds.
      expect(dbChangedIncludesOriginator(op)).toBe(true);
    },
  );

  it.each([...LONG_LIFECYCLE_OPS])(
    "echoes the long-lifecycle op %s back too",
    (op) => {
      // These can outlive the renderer's request budget, so the originator's
      // promise may already have rejected while the work succeeded.
      expect(dbChangedIncludesOriginator(op)).toBe(true);
    },
  );

  it.each(["chats.upsert", "project.rename", "git.commit", "file.write"])(
    "does NOT echo %s — the originator already applied it",
    (op) => {
      expect(dbChangedIncludesOriginator(op)).toBe(false);
    },
  );

  it("never echoes an op that publishes nothing", () => {
    expect(dbChangedKinds("some.read")).toBeNull();
    expect(dbChangedIncludesOriginator("some.read")).toBe(false);
  });
});
