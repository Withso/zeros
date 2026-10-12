import { describe, expect, it, vi } from "vitest";
import { BoatComputerTemplateSnapshots, verifyComputerTemplateSavedTree } from "./computer-template-snapshot-boat.js";
import { CloudProviderError } from "./provider.js";

const sourceSandboxId = "bx_23456789";
const snapshot = { name: "example-alpha-computer-v1", status: "ready" as const,
  sourceSandboxId, snapshotId: "snapshot_fixture", sizeBytes: 4096 };
const tree = (entries: unknown[] = []) => ({ ok: true, type: "snapshot.tree", snapshotId: snapshot.snapshotId,
  sandboxId: sourceSandboxId, treeAvailable: true, truncated: false,
  entries: [{ path: "__system__/srv/zeros/computer-template.json", kind: "file", size: 256 }, ...entries] });

describe("Computer saved-artifact proof", () => {
  it("binds the complete saved tree to both snapshot and stopped source, without returning paths", () => {
    const proof = verifyComputerTemplateSavedTree(tree(), snapshot);
    expect(proof).toEqual({ schema: "zeros.computer-saved-tree/v1", snapshotId: snapshot.snapshotId,
      sourceSandboxId, treeSha256: expect.stringMatching(/^[a-f0-9]{64}$/), entryCount: 1 });
    expect(JSON.stringify(proof)).not.toContain("/srv/");
  });

  it.each([
    { snapshotId: "another_snapshot" }, { sandboxId: "bx_abcdefgh" }, { truncated: true },
    { treeAvailable: false }, { type: "sandbox.tree" }, { entries: [] },
  ])("refuses incomplete or unrelated saved trees: %j", override => {
    expect(() => verifyComputerTemplateSavedTree({ ...tree(), ...override }, snapshot)).toThrow();
  });

  it.each([
    ".ssh/authorized_keys", "__system__/root/.ssh/authorized_keys", ".config/gh/hosts.yml",
    "__system__/root/.aws/credentials", "__system__/srv/zeros/home/agent/.codex/auth.json",
    "__system__/srv/zeros/state/owner-vault.json", "__system__/srv/zeros/setup/admission.json",
    "__system__/srv/zeros/log/install.log", ".env.private", "__system__/root/.gitconfig",
  ])("refuses captured private state at %s without echoing it", path => {
    try {
      verifyComputerTemplateSavedTree(tree([{ path, kind: "file", size: 64 }]), snapshot);
      expect.fail("private state was admitted");
    } catch (error) {
      expect(error).toMatchObject({ code: "provider_template_capture_invalid" });
      expect(String(error)).not.toContain(path);
    }
  });

  it.each([
    [{ path: ".ssh", kind: "symlink", target: "elsewhere" }],
    [{ path: "__system__/root/.ssh", kind: "symlink" }],
    [{ path: ".config", kind: "symlink" }],
    [{ path: ".local", kind: "symlink" }],
    [{ path: "__system__/root", kind: "symlink" }],
    [{ path: "__system__/srv/zeros", kind: "symlink" }],
    [{ path: "__system__/root/../root/.ssh/authorized_keys", kind: "file", size: 0 }],
    [{ path: "__system__/srv/zeros/computer-template.json", kind: "file", size: 256 }],
  ])("rejects aliases, unsafe ancestors and duplicate entries", entry => {
    expect(() => verifyComputerTemplateSavedTree(tree([entry]), snapshot)).toThrow();
  });

  it("accepts sanitized empty private files and directories, but not unknown sizes", () => {
    expect(verifyComputerTemplateSavedTree(tree([{ path: ".ssh/authorized_keys", kind: "file", size: 0 },
      { path: "__system__/srv/zeros/state/workspaces", kind: "directory" }]), snapshot).entryCount).toBe(3);
    expect(() => verifyComputerTemplateSavedTree(tree([{ path: ".ssh/authorized_keys", kind: "file" }]), snapshot)).toThrow();
  });

  it.each([
    ".zeros-persist/state/owner-vault.json",
    ".zeros-persist/state/engine.sqlite",
    ".zeros-persist/home/agent/.claude/settings.json",
    ".zeros-persist/home/agent/.codex/auth.json",
  ])("refuses private state in the native backing tree at %s", path => {
    for (const size of [64, undefined]) {
      expect(() => verifyComputerTemplateSavedTree(tree([{ path, kind: "file", size }]), snapshot))
        .toThrow(expect.objectContaining({ code: "provider_template_capture_invalid" }));
    }
  });

  it.each([".zeros-persist", ".zeros-persist/home", ".zeros-persist/state", ".zeros-persist/home/agent"])(
    "refuses an aliased native private root or ancestor %s", path => {
      for (const kind of ["symlink", "hardlink", "socket", "unknown"]) {
        expect(() => verifyComputerTemplateSavedTree(tree([{ path, kind }]), snapshot))
          .toThrow(expect.objectContaining({ code: "provider_template_capture_invalid" }));
      }
    },
  );

  it("accepts empty native private roots and retains ordinary repository contents", () => {
    const entries = [
      { path: ".zeros-persist", kind: "directory" },
      { path: ".zeros-persist/home", kind: "directory" },
      { path: ".zeros-persist/home/agent/.codex/auth.json", kind: "file", size: 0 },
      { path: ".zeros-persist/state", kind: "directory" },
      { path: ".zeros-persist/state/workspaces", kind: "directory" },
      { path: ".zeros-persist/files", kind: "directory" },
      { path: ".zeros-persist/files/repos/example/package.json", kind: "file", size: 256 },
    ];
    expect(verifyComputerTemplateSavedTree(tree(entries), snapshot).entryCount).toBe(entries.length + 1);
    expect(() => verifyComputerTemplateSavedTree(tree([...entries, entries[1]]), snapshot)).toThrow();
  });
});

describe("Boat Computer named snapshots", () => {
  it.each(["example-beta-computer-v1", "example-production-computer-v1", "example-development-computer-v1",
    "zeros-alpha-runtime-v1", "zeros-qualification-fixture", "zeros-base-v1", "example-alpha-computer-v01"])(
    "refuses foreign or unowned name %s before every provider call", async name => {
      const request = vi.fn();
      const provider = new BoatComputerTemplateSnapshots({ request }, "fixture-wallet", "alpha");
      await expect(provider.get(name)).rejects.toThrow();
      await expect(provider.save(sourceSandboxId, name)).rejects.toThrow();
      await expect(provider.prove({ ...snapshot, name })).rejects.toThrow();
      await expect(provider.remove({ ...snapshot, name })).rejects.toThrow();
      expect(request).not.toHaveBeenCalled();
    },
  );
  it("requires the stopped, unmonitored source wallet before saving", async () => {
    const request = vi.fn(async () => ({ sandbox: { id: sourceSandboxId, state: "running", team: { id: "fixture-wallet" },
      monitoring: false, snapshotAvailable: true, lastSnapshotStatus: "completed" } }));
    const provider = new BoatComputerTemplateSnapshots({ request }, "fixture-wallet", "alpha");
    await expect(provider.assertStopped(sourceSandboxId)).rejects.toMatchObject({ code: "provider_template_capture_invalid" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("uses a bounded complete-tree read and rejects a changed name after proof", async () => {
    const request = vi.fn(async (path: string) => path.startsWith("/snapshots/") ? tree() :
      { snapshot: { ...snapshot, snapshotId: "substituted_snapshot" } });
    const provider = new BoatComputerTemplateSnapshots({ request }, "fixture-wallet", "alpha");
    await expect(provider.prove(snapshot)).rejects.toMatchObject({ code: "provider_template_capture_invalid" });
    expect(request).toHaveBeenCalledWith(`/snapshots/${snapshot.snapshotId}/tree`,
      expect.objectContaining({ maxResponseBytes: 64 * 1024 * 1024 }));
  });

  it("checks source and exact snapshot before removing a name and confirms absence", async () => {
    const request = vi.fn().mockResolvedValueOnce({ snapshot })
      .mockResolvedValueOnce({ ok: true }).mockRejectedValueOnce(new CloudProviderError("provider_not_found", "absent", false));
    const provider = new BoatComputerTemplateSnapshots({ request }, "fixture-wallet", "alpha");
    await expect(provider.remove(snapshot)).resolves.toBe(true);
    expect(request).toHaveBeenNthCalledWith(2, `/named-snapshots/${snapshot.name}`,
      expect.objectContaining({ method: "DELETE", confirmDelete: snapshot.name }));
    request.mockReset().mockResolvedValue({ snapshot: { ...snapshot, sourceSandboxId: "bx_abcdefgh" } });
    await expect(provider.remove(snapshot)).rejects.toMatchObject({ code: "provider_template_capture_invalid" });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
