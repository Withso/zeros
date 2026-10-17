import { describe, expect, it } from "vitest";
import type { LocalLink } from "@zeros/protocol/local-orchestration";
import type { LocalLinkSnapshot } from "../../platform/local-link-snapshot";
import type { Workspace } from "../../platform/git";
import type { ChatRowWire } from "../../features/agent/agent-history-client";
import { resolveLocalLinkDestination } from "../local-link-navigation";

const project = {
  id: "proj_123456789abc",
  repoRoot: "/repo",
  repoSlug: "repo",
  name: "Repo",
  originUrl: null,
  addedAt: 1,
};
const registered = [{ ...project, id: "renderer-uuid", isGitRepository: true }];
const workspace = {
  id: "ws_one",
  path: "/worktree",
  repoRoot: "/repo",
  repoSlug: "repo",
  placement: "local",
  organizationId: null,
  archivedAt: null,
  present: true,
} as Workspace;
const chat = {
  id: "chat_one",
  folder: "/worktree",
  kind: "chat",
  archived: false,
  updatedAt: 1,
} as ChatRowWire;
const snapshot = (
  patch: Partial<LocalLinkSnapshot> = {},
): LocalLinkSnapshot => ({
  projects: [project],
  workspaces: [workspace],
  chats: [chat],
  ...patch,
});
const link = (kind: LocalLink["kind"], id: string): LocalLink => ({
  scheme: "zeros",
  kind,
  id,
});

describe("Local navigation destinations", () => {
  it("resolves an existing managed chat and its exact cwd", () => {
    const nested = { ...chat, folder: "/worktree/src" };
    expect(
      resolveLocalLinkDestination(
        link("chat", chat.id),
        snapshot({ chats: [nested] }),
        registered,
      ),
    ).toEqual({ ok: true, workspace, folder: nested.folder, chat: nested });
  });

  it.each([true, false])(
    "resolves an engine folder id for a Git=%s registered root",
    (isGitRepository) => {
      const row = { ...chat, folder: "/repo" };
      const result = resolveLocalLinkDestination(
        link("workspace", `folder:${project.id}`),
        snapshot({ chats: [row] }),
        [{ ...registered[0]!, isGitRepository }],
      );
      expect(result).toMatchObject({
        ok: true,
        folder: "/repo",
        chat: row,
        workspace: { id: "local:repo", path: "/repo" },
      });
      expect(
        resolveLocalLinkDestination(
          link("workspace", "folder:renderer-uuid"),
          snapshot(),
          registered,
        ),
      ).toEqual({ ok: false, reason: "not-found" });
    },
  );

  it("selects an empty workspace without manufacturing a chat", () => {
    expect(
      resolveLocalLinkDestination(
        link("workspace", workspace.id),
        snapshot({ chats: [] }),
        registered,
      ),
    ).toEqual({ ok: true, workspace, folder: workspace.path, chat: null });
  });

  it("prefers the selected live chat and otherwise uses a recent agent chat", () => {
    const newer = { ...chat, id: "newer", updatedAt: 2 };
    const terminal = {
      ...chat,
      id: "terminal",
      kind: "terminal",
      updatedAt: 3,
    };
    const rows = snapshot({ chats: [chat, newer, terminal] });
    expect(
      resolveLocalLinkDestination(
        link("workspace", workspace.id),
        rows,
        registered,
        chat.id,
      ),
    ).toMatchObject({ chat });
    expect(
      resolveLocalLinkDestination(
        link("workspace", workspace.id),
        rows,
        registered,
      ),
    ).toMatchObject({ chat: newer });
  });

  it.each([{ organizationId: "org-one" }, { placement: "cloud" }])(
    "refuses a foreign owner/placement: %j",
    (patch) => {
      const rows = snapshot({
        workspaces: [{ ...workspace, ...patch } as Workspace],
      });
      for (const target of [
        link("chat", chat.id),
        link("workspace", workspace.id),
      ]) {
        expect(resolveLocalLinkDestination(target, rows, registered)).toEqual({
          ok: false,
          reason: "local-only",
        });
      }
    },
  );

  it("does not mistake a cloud-primary local-main trunk for a Personal folder", () => {
    const rows = snapshot({
      workspaces: [
        { ...workspace, id: "local-main", path: "/repo", placement: "cloud" },
      ],
      chats: [{ ...chat, folder: "/repo" }],
    });
    for (const target of [
      link("chat", chat.id),
      link("workspace", `folder:${project.id}`),
    ]) {
      expect(resolveLocalLinkDestination(target, rows, registered)).toEqual({
        ok: false,
        reason: "local-only",
      });
    }
  });

  it.each([{ archivedAt: 1 }, { present: false }])(
    "refuses archived or missing worktrees: %j",
    (patch) => {
      expect(
        resolveLocalLinkDestination(
          link("chat", chat.id),
          snapshot({ workspaces: [{ ...workspace, ...patch }] }),
          registered,
        ),
      ).toEqual({ ok: false, reason: "not-found" });
    },
  );

  it("refuses unknown, hidden, archived, terminal, and cloud chat destinations", () => {
    expect(
      resolveLocalLinkDestination(
        link("chat", "unknown"),
        snapshot(),
        registered,
      ),
    ).toMatchObject({ ok: false });
    expect(
      resolveLocalLinkDestination(link("chat", chat.id), snapshot(), []),
    ).toMatchObject({ ok: false });
    for (const patch of [{ archived: true }, { kind: "terminal" }]) {
      expect(
        resolveLocalLinkDestination(
          link("chat", chat.id),
          snapshot({ chats: [{ ...chat, ...patch }] }),
          registered,
        ),
      ).toEqual({ ok: false, reason: "not-found" });
    }
    expect(
      resolveLocalLinkDestination(
        link("chat", chat.id),
        snapshot({ chats: [{ ...chat, folder: "cloud://org/workspace" }] }),
        registered,
      ),
    ).toEqual({ ok: false, reason: "local-only" });
  });

  it("keeps nested managed worktree ownership ahead of a repository root", () => {
    const nested = {
      ...workspace,
      path: "/repo/nested",
      organizationId: "org-one",
    };
    expect(
      resolveLocalLinkDestination(
        link("chat", chat.id),
        snapshot({
          workspaces: [nested],
          chats: [{ ...chat, folder: "/repo/nested/src" }],
        }),
        registered,
      ),
    ).toEqual({ ok: false, reason: "local-only" });
  });

  it("uses the most specific workspace even when local-main is listed first", () => {
    const root = { ...workspace, id: "local-main", path: "/repo" };
    const nested = {
      ...workspace,
      path: "/repo/nested",
      organizationId: "org-one",
    };
    expect(
      resolveLocalLinkDestination(
        link("chat", chat.id),
        snapshot({
          workspaces: [root, nested],
          chats: [{ ...chat, folder: "/repo/nested/src" }],
        }),
        registered,
      ),
    ).toEqual({ ok: false, reason: "local-only" });
  });
});
