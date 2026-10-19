import { describe, expect, it, vi } from "vitest";
import { BoatComputerTemplateSnapshots, verifyComputerTemplateSavedTree } from "./computer-template-snapshot-boat.js";
import { CloudProviderError } from "./provider.js";

const sourceSandboxId = "bx_23456789";
const snapshot = { name: "example-alpha-computer-v1", status: "ready" as const,
  sourceSandboxId, snapshotId: "snapshot_fixture", sizeBytes: 4096 };
const tree = (entries: unknown[] = []) => ({ ok: true, type: "snapshot.tree", snapshotId: snapshot.snapshotId,
  sandboxId: sourceSandboxId, treeAvailable: true, truncated: false,
  entries: [{ path: "__system__/srv/zeros/computer-template.json", kind: "file", size: 256 }, ...entries] });
const boatTree = () => ({ ...tree([
  { path: "__system__", kind: "dir" },
  { path: "__system__/srv", kind: "dir" },
  { path: "__system__/srv/zeros", kind: "dir" },
  { path: "__system__/srv/zeros/state", kind: "dir" },
  { path: "__system__/etc", kind: "dir" },
  { path: "__system__/etc/systemd", kind: "dir" },
  { path: "__system__/etc/systemd/system", kind: "dir" },
  { path: "__system__/etc/systemd/system/fixture\\x2dvolume.service", kind: "file", size: 128 },
  { path: "__system__/etc/systemd/system/multi-user.target.wants", kind: "dir" },
  { path: "__system__/etc/systemd/system/multi-user.target.wants/fixture\\x2dvolume.service", kind: "symlink" },
  { path: ".zeros-persist", kind: "dir" },
  { path: ".zeros-persist/home", kind: "dir" },
  { path: ".zeros-persist/state", kind: "dir" },
  { path: ".ssh", kind: "dir" },
  { path: ".ssh/authorized_keys", kind: "file", size: 0 },
]), generation: 7, fileCount: 3, totalSizeBytes: 384 });

describe("Computer saved-artifact proof", () => {
  const qualification = { buildId: "11111111-1111-4111-8111-111111111111", evidenceSha256: "a".repeat(64), evidenceBytes: 4096 };
  const recordRoot = `__system__/srv/zeros/runtime-installs/build-qualifications/${qualification.buildId}`;
  const records = () => [
    { path: `${recordRoot}/integrity.json`, kind: "file", size: 8192 },
    { path: `${recordRoot}/evidence.json`, kind: "file", size: qualification.evidenceBytes },
    { path: `${recordRoot}/report.json`, kind: "file", size: 2048 },
  ];

  it("requires all three bounded qualification records when CP recorded the exact build", () => {
    const proof = verifyComputerTemplateSavedTree(tree(records()), snapshot, qualification);
    expect(proof.qualification).toEqual(qualification);
    for (const missing of records()) {
      expect(() => verifyComputerTemplateSavedTree(tree(records().filter(entry => entry.path !== missing.path)), snapshot, qualification)).toThrow();
    }
  });

  it("retains a complete bounded Python closure larger than the public evidence record", () => {
    const entries = records();
    entries[0] = { ...entries[0], size: 1_048_576 };
    expect(verifyComputerTemplateSavedTree(tree(entries), snapshot, qualification).qualification).toEqual(qualification);
  });

  it("does not accept unacknowledged, extra, empty, aliased or oversized qualification records", () => {
    expect(() => verifyComputerTemplateSavedTree(tree(records()), snapshot)).toThrow();
    const originals = records();
    const wrong = [
      ...[0, qualification.evidenceBytes - 1, 65_537].map(size => [originals[0], { ...originals[1], size }, originals[2]]),
      [originals[0], { ...originals[1], kind: "symlink" }, originals[2]],
      [{ ...originals[0], size: 8_388_609 }, originals[1], originals[2]],
      [originals[0], originals[1], { ...originals[2], size: 65_537 }],
      [...originals, { path: `${recordRoot}/private.json`, kind: "file", size: 0 }],
      [...originals, { path: `${recordRoot}-other/evidence.json`, kind: "file", size: 4096 }],
      [...originals, { path: "__system__/srv/zeros/runtime-installs", kind: "symlink" }],
    ];
    for (const entries of wrong) expect(() => verifyComputerTemplateSavedTree(tree(entries), snapshot, qualification)).toThrow();
  });

  it("keeps ordinary private-tree refusal when retaining credential-free qualification records", () => {
    expect(() => verifyComputerTemplateSavedTree(tree([...records(),
      { path: ".zeros-persist/state/private.json", kind: "file", size: 64 }]), snapshot, qualification)).toThrow();
    expect(verifyComputerTemplateSavedTree(tree(), snapshot).qualification).toBeUndefined();
  });

  it("binds the complete saved tree to both snapshot and stopped source, without returning paths", () => {
    const proof = verifyComputerTemplateSavedTree(tree(), snapshot);
    expect(proof).toEqual({ schema: "zeros.computer-saved-tree/v1", snapshotId: snapshot.snapshotId,
      sourceSandboxId, treeSha256: expect.stringMatching(/^[a-f0-9]{64}$/), entryCount: 1 });
    expect(JSON.stringify(proof)).not.toContain("/srv/");
  });

  it("accepts Boat's dir/file/symlink tree, file-only sizes and extra response metadata", () => {
    const value = boatTree();
    const proof = verifyComputerTemplateSavedTree(value, snapshot);
    expect(proof).toEqual({ schema: "zeros.computer-saved-tree/v1", snapshotId: snapshot.snapshotId,
      sourceSandboxId, treeSha256: expect.stringMatching(/^[a-f0-9]{64}$/), entryCount: value.entries.length });
    expect(verifyComputerTemplateSavedTree({ ...value, entries: [...value.entries].reverse() }, snapshot)).toEqual(proof);
    expect(JSON.stringify(proof)).not.toContain("volume.service");
  });

  it("treats systemd backslash escapes as literal POSIX filename characters", () => {
    const path = "__system__/etc/systemd/system/fixture\\x2dvolume.service";
    const proof = verifyComputerTemplateSavedTree(tree([{ path, kind: "file", size: 128 }]), snapshot);
    const unescaped = verifyComputerTemplateSavedTree(tree([{ path: path.replace("\\x2d", "-"), kind: "file", size: 128 }]), snapshot);
    expect(proof.entryCount).toBe(2);
    expect(proof.treeSha256).not.toBe(unescaped.treeSha256);
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
    ".ssh/fixture\\x2dkey", "__system__/root/.config/gh/fixture\\x2dauth",
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

  it.each(["symlink", "file", "hardlink", "socket", "unknown"])(
    "rejects a %s ancestor even outside private roots", kind => {
      const path = "__system__/etc/systemd/system/fixture\\x2dvolume.service";
      expect(() => verifyComputerTemplateSavedTree(tree([
        { path, kind, ...(kind === "file" ? { size: 0 } : {}) },
        { path: `${path}/child`, kind: "file", size: 0 },
      ]), snapshot)).toThrow(expect.objectContaining({ code: "provider_template_capture_invalid" }));
    },
  );

  it.each(["/repo/file", "repo/file/", "repo//file", "repo/./file", "repo/../file",
    "repo/line\nfeed", "repo/tab\tname", "repo/null\0name", "repo/delete\x7fname"])(
    "rejects noncanonical paths and control characters: %j", path => {
      expect(() => verifyComputerTemplateSavedTree(tree([{ path, kind: "file", size: 0 }]), snapshot))
        .toThrow(expect.objectContaining({ code: "provider_template_capture_invalid" }));
    },
  );

  it("accepts sanitized empty private files and directories, but not unknown sizes", () => {
    expect(verifyComputerTemplateSavedTree(tree([{ path: ".ssh/authorized_keys", kind: "file", size: 0 },
      { path: "__system__/srv/zeros/state/workspaces", kind: "dir" }]), snapshot).entryCount).toBe(3);
    expect(() => verifyComputerTemplateSavedTree(tree([{ path: ".ssh/authorized_keys", kind: "file" }]), snapshot)).toThrow();
  });

  it.each([
    ".zeros-persist/state/owner-vault.json",
    ".zeros-persist/state/engine.sqlite",
    ".zeros-persist/home/agent/.claude/settings.json",
    ".zeros-persist/home/agent/.codex/auth.json",
    ".zeros-persist/home/agent/fixture\\x2dauth",
    ".zeros-persist/state/fixture\\x2dvault",
  ])("refuses private state in the native backing tree at %s", path => {
    for (const size of [64, undefined]) {
      expect(() => verifyComputerTemplateSavedTree(tree([{ path, kind: "file", size }]), snapshot))
        .toThrow(expect.objectContaining({ code: "provider_template_capture_invalid" }));
    }
  });

  it.each([
    "__system__/srv/zeros/files/home/agent/private.json",
    "__system__/srv/zeros/files/state/private.json",
    "__system__/srv/zeros/files/.zeros-setup/private.json",
    ".zeros-persist/files/home/agent/private.json",
    ".zeros-persist/files/state/private.json",
    ".zeros-persist/files/managed-settings/private.json",
    ".zeros-persist/files/.zeros-setup/private.json",
    ".zeros-persist/files/repos-old/private.json",
    "__system__/srv/zeros/managed-settings/previous/private.json",
  ])("refuses inherited content that sanitation clears outside the selected repositories: %s", path => {
    for (const entry of [{ path, kind: "file", size: 64 }, { path, kind: "file" }, { path, kind: "symlink" }]) {
      expect(() => verifyComputerTemplateSavedTree(tree([entry]), snapshot))
        .toThrow(expect.objectContaining({ code: "provider_template_capture_invalid" }));
    }
  });

  it.each([
    "__system__/srv/zeros/managed-settings/settings.managed.toml",
    "__system__/etc/machine-id",
    "__system__/var/lib/systemd/random-seed",
    "__system__/var/lib/systemd/timesync/clock",
    "__system__/opt/zeros/disk-epoch",
    "__system__/run/zeros/active-runtime.json",
  ])("refuses private descendants when a sanitized file is captured as a directory: %s", path => {
    expect(() => verifyComputerTemplateSavedTree(tree([
      { path, kind: "dir" }, { path: `${path}/private.json`, kind: "file", size: 64 },
    ]), snapshot)).toThrow(expect.objectContaining({ code: "provider_template_capture_invalid" }));
  });

  it.each([".zeros-persist", ".zeros-persist/home", ".zeros-persist/state", ".zeros-persist/home/agent",
    ".zeros-persist/files", "__system__/srv/zeros/files", "__system__/srv/zeros/managed-settings"])(
    "refuses an aliased native private root or ancestor %s", path => {
      for (const kind of ["symlink", "hardlink", "socket", "unknown"]) {
        expect(() => verifyComputerTemplateSavedTree(tree([{ path, kind }]), snapshot))
          .toThrow(expect.objectContaining({ code: "provider_template_capture_invalid" }));
      }
    },
  );

  it("accepts empty native private roots and retains ordinary repository contents", () => {
    const entries = [
      { path: ".zeros-persist", kind: "dir" },
      { path: ".zeros-persist/home", kind: "dir" },
      { path: ".zeros-persist/home/agent/.codex/auth.json", kind: "file", size: 0 },
      { path: ".zeros-persist/state", kind: "dir" },
      { path: ".zeros-persist/state/workspaces", kind: "dir" },
      { path: ".zeros-persist/files", kind: "dir" },
      { path: ".zeros-persist/files/repos/example/package.json", kind: "file", size: 256 },
    ];
    expect(verifyComputerTemplateSavedTree(tree(entries), snapshot).entryCount).toBe(entries.length + 1);
    expect(() => verifyComputerTemplateSavedTree(tree([...entries, entries[1]]), snapshot)).toThrow();
  });

  it("accepts explicit empty replacements throughout sanitized trees and preserves both repository representations", () => {
    const entries = [
      { path: "__system__/srv/zeros/files/home/agent", kind: "dir" },
      { path: "__system__/srv/zeros/files/home/agent/private.json", kind: "file", size: 0 },
      { path: ".zeros-persist/files/state/private.json", kind: "file", size: 0 },
      { path: "__system__/srv/zeros/managed-settings/previous/private.json", kind: "file", size: 0 },
      { path: "__system__/opt/zeros/disk-epoch", kind: "file", size: 0 },
      { path: "__system__/opt/zeros/sessions/boot.json", kind: "file", size: 0 },
      { path: "__system__/srv/zeros/files/repos/example/package.json", kind: "file", size: 256 },
      { path: ".zeros-persist/files/repos/example/package.json", kind: "file", size: 256 },
    ];
    expect(verifyComputerTemplateSavedTree(tree(entries), snapshot).entryCount).toBe(entries.length + 1);
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

  it("proves the real wire shape and rechecks the named artifact without saving it", async () => {
    const value = boatTree();
    const request = vi.fn().mockResolvedValueOnce(value).mockResolvedValueOnce({ snapshot });
    const provider = new BoatComputerTemplateSnapshots({ request }, "fixture-wallet", "alpha");
    await expect(provider.prove(snapshot)).resolves.toMatchObject({ snapshotId: snapshot.snapshotId,
      sourceSandboxId, entryCount: value.entries.length });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(1, `/snapshots/${snapshot.snapshotId}/tree`,
      expect.objectContaining({ maxResponseBytes: 64 * 1024 * 1024 }));
    expect(request).toHaveBeenNthCalledWith(2, `/named-snapshots/${snapshot.name}`, expect.any(Object));
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
