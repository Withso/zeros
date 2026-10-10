import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { closeState, setStateRootForTesting } from "../../git";
import { insertWorkspace } from "../../git/state";
import { closeZerosDb, setZerosDbPathForTesting } from "../../db/database";
import { getChat, getChatLocation, setChatWorkspaceResolver, upsertChat, type ChatRow } from "../../db/chats";
import { LOCAL_MAIN_WORKSPACE_ID, WorkspaceService } from "../service";

vi.mock("node:crypto", async importActual => {
  const actual = await importActual<typeof import("node:crypto")>();
  return { ...actual, createHash: vi.fn(actual.createHash) };
});

const organizationId = "11111111-1111-4111-8111-111111111111";
const owners = [
  { name: "Local Personal", placement: "local", organizationId: null },
  { name: "organization local", placement: "local", organizationId },
  { name: "organization cloud", placement: "cloud", organizationId },
] as const;

describe("workspace process ownership and remote folder restrictions", () => {
  let directory: string;
  let root: string;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "zeros-folder-identity-"));
    root = path.join(directory, "repo");
    mkdirSync(root);
    setStateRootForTesting(path.join(directory, "state"));
    setZerosDbPathForTesting(path.join(directory, "chats.sqlite"));
  });

  afterEach(() => {
    vi.clearAllMocks();
    setChatWorkspaceResolver(null);
    closeZerosDb();
    setZerosDbPathForTesting(null);
    closeState();
    setStateRootForTesting(null);
    rmSync(directory, { recursive: true, force: true });
  });

  it.each(owners)("resolves $name process ownership without hashing unmanaged input", owner => {
    const service = new WorkspaceService(root, { primaryDesignWorkspace: owner.placement === "cloud" });
    const nested = path.join(root, "nested");
    mkdirSync(nested);
    insertWorkspace({ ...service["localMainEntry"](), id: "nested-owner", path: nested,
      placement: owner.placement, organizationId: owner.organizationId });
    vi.mocked(createHash).mockClear();

    expect(service.workspaceIdForCwd(root)).toBe(LOCAL_MAIN_WORKSPACE_ID);
    expect(service.workspaceIdForCwd(path.join(root, "ordinary-subdir"))).toBe(LOCAL_MAIN_WORKSPACE_ID);
    expect(service.workspaceIdForCwd(path.join(nested, "src"))).toBe("nested-owner");
    expect(service.workspaceIdForCwd("nested-owner")).toBe("nested-owner");
    expect(service.workspaceIdForCwd("/outside/synthetic-session/cwd")).toBeNull();
    expect(service.workspaceIdForCwd("ext:1d18bab9e36c")).toBeNull();
    expect(service.workspaceIdForCwd(undefined)).toBeNull();
    expect(createHash).not.toHaveBeenCalled();
  });

  it("preserves opaque IDs and normalized managed-folder aliases", () => {
    const service = new WorkspaceService(root);
    const workspaces = [{ ...service["localMainEntry"](), id: "temporary-owner", path: "/tmp/managed" }];
    expect(service["managedWorkspaceTokenForFolder"]("/outside/legacy-folder", [])).toBeNull();
    expect(service["managedWorkspaceTokenForFolder"]("/tmp/managed/src", workspaces)).toBe("temporary-owner");
    expect(service["managedWorkspaceTokenForFolder"]("/private/tmp/managed/src", workspaces)).toBe("temporary-owner");
    expect(service["managedWorkspaceTokenForFolder"]("remote-made", [])).toBe("remote-made");
    expect(service["managedWorkspaceTokenForFolder"]("ext:1d18bab9e36c", [])).toBe("ext:1d18bab9e36c");
    expect(service["managedWorkspaceTokenForFolder"]("", [])).toBe("");
    expect(createHash).not.toHaveBeenCalled();
  });

  it.each(owners)("preserves $name persisted chat folders and workspace keys", owner => {
    const service = new WorkspaceService(root, { primaryDesignWorkspace: owner.placement === "cloud" });
    const nested = path.join(root, "nested");
    mkdirSync(nested);
    insertWorkspace({ ...service["localMainEntry"](), id: "nested-owner", path: nested,
      placement: owner.placement, organizationId: owner.organizationId });
    const template: ChatRow = { id: "", folder: "", agentId: null, agentName: null, model: null, effort: "",
      permissionMode: "", lastModeId: null, prePlanModeId: null, fast: false, additionalDirectories: [],
      title: "", createdAt: 1, updatedAt: 1, sessionId: "synthetic-native-session", pinned: false,
      archived: false, sourceChatId: null, kind: null };
    for (const [id, folder, workspaceId] of [
      ["primary", root, LOCAL_MAIN_WORKSPACE_ID],
      ["nested", path.join(nested, "src"), "nested-owner"],
      ["unmanaged", "/outside/legacy-folder", null],
      ["unmanaged-id", "remote-made", null],
    ] as const) {
      upsertChat({ ...template, id, folder });
      expect(getChat(id)?.folder).toBe(folder);
      expect(getChat(id)?.sessionId).toBe(template.sessionId);
      expect(getChatLocation(id)).toEqual({ folder, workspaceId });
    }
    // Owner/placement switches re-resolve the same durable folder and IDs.
    const next = new WorkspaceService(root, { primaryDesignWorkspace: owner.placement !== "cloud" });
    expect(next.workspaceIdForCwd(getChat("nested")!.folder)).toBe("nested-owner");
    expect(next.workspaceIdForCwd(getChat("unmanaged-id")!.folder)).toBeNull();
  });

  it.each(owners)("keeps $name remote chat restrictions without hashing any folder", async owner => {
    const service = new WorkspaceService(root, { primaryDesignWorkspace: owner.placement === "cloud" });
    const nested = path.join(root, "nested");
    mkdirSync(nested);
    insertWorkspace({ ...service["localMainEntry"](), id: "nested-owner", path: nested,
      placement: owner.placement, organizationId: owner.organizationId });
    const folders = [
      ["managed-path", path.join(nested, "src")],
      ["managed-id", "nested-owner"],
      ["primary-path", root],
      ["primary-id", LOCAL_MAIN_WORKSPACE_ID],
      ["unmanaged", "/outside/synthetic-native-session/cwd"],
      ["opaque", "remote-made"],
      ["empty", ""],
    ] as const;
    for (const [id, folder] of folders)
      await service.handle("chats.upsert", { chat: { id, folder, sessionId: "synthetic-native-session" } });
    await service.handle("workspace.setRemoteRestricted", { workspaceId: "nested-owner", restricted: true });
    vi.mocked(createHash).mockClear();

    const remote = await service.handle("chats.list", {}, { remote: true }) as { chats: ChatRow[] };
    const visible = folders.filter(([id]) => !id.startsWith("managed-"));
    expect(Object.fromEntries(remote.chats.map(chat => [chat.id, chat.folder]))).toEqual(Object.fromEntries(visible));
    const local = await service.handle("chats.list") as { chats: ChatRow[] };
    expect(Object.fromEntries(local.chats.map(chat => [chat.id, chat.folder]))).toEqual(Object.fromEntries(folders));
    for (const [id, folder] of folders) {
      const clear = service.handle("messages.clear", { chatId: id }, { remote: true });
      const write = () => service.handle("chats.upsert", { chat: { id: `remote-${id}`, folder } }, { remote: true });
      if (id.startsWith("managed-")) {
        await expect(clear).rejects.toThrow(/restricted/i);
        await expect(write()).rejects.toThrow(/restricted/i);
        expect(getChat(`remote-${id}`)).toBeNull();
      } else {
        await expect(clear).resolves.toEqual({ cleared: 0 });
        await expect(write()).resolves.toEqual({ ok: true });
        expect(getChat(`remote-${id}`)?.folder).toBe(folder);
      }
    }
    await expect(service.handle("chats.upsert", {
      chat: { id: "managed-path", folder: "/outside/forged-destination" },
    }, { remote: true })).rejects.toThrow(/restricted/i);
    expect(getChat("managed-path")?.folder).toBe(path.join(nested, "src"));

    await service.handle("workspace.setRemoteRestricted", { workspaceId: LOCAL_MAIN_WORKSPACE_ID, restricted: true });
    for (const id of ["primary-path", "primary-id"])
      await expect(service.handle("messages.clear", { chatId: id }, { remote: true })).rejects.toThrow(/restricted/i);
    const next = new WorkspaceService(root, { primaryDesignWorkspace: owner.placement !== "cloud" });
    const switched = await next.handle("chats.list", {}, { remote: true }) as { chats: ChatRow[] };
    expect(switched.chats.map(chat => chat.id).sort()).toEqual([
      "empty", "opaque", "remote-empty", "remote-opaque", "remote-unmanaged", "unmanaged",
    ]);
    expect(createHash).not.toHaveBeenCalled();
  });

  it("exempts only the cloud primary Design workspace while explicit restrictions still win", async () => {
    const service = new WorkspaceService(root, { primaryDesignWorkspace: true });
    insertWorkspace({ ...service["localMainEntry"](), kind: "design", placement: "cloud", organizationId });
    const nested = path.join(root, "other-design");
    mkdirSync(nested);
    insertWorkspace({ ...service["localMainEntry"](), id: "other-design", path: nested,
      canonicalId: "33333333-3333-4333-8333-333333333333", branch: "other-design",
      kind: "design", placement: "cloud", organizationId });
    for (const [id, folder] of [
      ["primary-path", root], ["primary-id", LOCAL_MAIN_WORKSPACE_ID],
      ["design-path", nested], ["design-id", "other-design"],
      ["unmanaged", "/outside/synthetic-native-session/cwd"],
    ]) await service.handle("chats.upsert", { chat: { id, folder } });
    vi.mocked(createHash).mockClear();

    const cloud = await service.handle("chats.list", {}, { remote: true }) as { chats: ChatRow[] };
    expect(cloud.chats.map(chat => chat.id).sort()).toEqual(["primary-id", "primary-path", "unmanaged"]);
    await expect(service.handle("messages.clear", { chatId: "primary-path" }, { remote: true })).resolves.toEqual({ cleared: 0 });
    await expect(service.handle("messages.clear", { chatId: "design-path" }, { remote: true })).rejects.toThrow(/restricted/i);
    await expect(service.handle("chats.upsert", {
      chat: { id: "design-write", folder: nested },
    }, { remote: true })).rejects.toThrow(/restricted/i);

    const localPolicy = new WorkspaceService(root);
    const local = await localPolicy.handle("chats.list", {}, { remote: true }) as { chats: ChatRow[] };
    expect(local.chats.map(chat => chat.id)).toEqual(["unmanaged"]);
    await expect(localPolicy.handle("messages.clear", { chatId: "primary-id" }, { remote: true })).rejects.toThrow(/restricted/i);
    await service.handle("workspace.setRemoteRestricted", { workspaceId: LOCAL_MAIN_WORKSPACE_ID, restricted: true });
    const restricted = await service.handle("chats.list", {}, { remote: true }) as { chats: ChatRow[] };
    expect(restricted.chats.map(chat => chat.id)).toEqual(["unmanaged"]);
    await expect(service.handle("messages.clear", { chatId: "primary-path" }, { remote: true })).rejects.toThrow(/restricted/i);
    await expect(service.handle("messages.clear", { chatId: "unmanaged" }, { remote: true })).resolves.toEqual({ cleared: 0 });
    expect(createHash).not.toHaveBeenCalled();
  });
});
