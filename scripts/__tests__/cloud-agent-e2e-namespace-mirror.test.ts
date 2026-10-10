// Private-view filesystem/SQLite ports are synthetic here; no namespace or
// provider qualification is inferred from these guard regressions.
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { readPrivateFixtureMirrorProof } from "../cloud-workspace-validation/cloud-agent-e2e/namespace-mirror-proof";
import * as mirror from "../cloud-workspace-validation/cloud-agent-e2e/namespace-mirror-proof";
import { fixtureDescriptor } from "../cloud-workspace-validation/cloud-agent-e2e/runtime-contract";
import { readFixtureLocalMirrorProof } from "../cloud-workspace-validation/cloud-agent-e2e/local-mirror-proof";
vi.mock("../cloud-workspace-validation/cloud-agent-e2e/local-mirror-proof", () => ({ readFixtureLocalMirrorProof: vi.fn(() => ({ version: 1 })) }));

function fixture() {
  const scope = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 1, engineInstanceId: randomUUID(),
    bootId: randomUUID(), writerEpoch: randomUUID(), fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 1 };
  const file = `/srv/zeros/state/engines/workspace-${createHash("sha256").update("/srv/zeros/workspace").digest("hex").slice(0, 12)}/cloud-local-commands.sqlite`;
  const state = { uid: 0, mountNamespace: "mnt:[2]", pidNamespace: "pid:[2]", pid: 1, rootType: 0x1021994,
    procType: 0x9fa0, initNamespace: "pid:[2]", realpath: file, owner: 10003, links: 1, mode: 0o600, symlink: false };
  const handle = { readonly: true, close: vi.fn() };
  const io = { observe: vi.fn(() => state), realpath: vi.fn(() => state.realpath),
    metadata: vi.fn(() => ({ uid: state.owner, gid: 10003, nlink: state.links, mode: state.mode,
      isFile: () => true, isSymbolicLink: () => state.symlink })), open: vi.fn(() => handle) };
  return { file, state, handle, io, input: { outerMountNamespace: "mnt:[1]", outerPidNamespace: "pid:[1]",
    scope, commandId: randomUUID().toString(), conversationId: randomUUID().toString() } };
}
describe("private fixed-path local mirror proof open", () => {
  it("opens only the fixed actual engine path read-only after private root/mount/PID/proc proof", () => {
    const f = fixture(); readPrivateFixtureMirrorProof(f.input, f.io);
    expect(f.io.open).toHaveBeenCalledExactlyOnceWith(f.file, { readonly: true, fileMustExist: true });
    expect(f.io.observe.mock.invocationCallOrder[0]).toBeLessThan(f.io.metadata.mock.invocationCallOrder[0]!);
    expect(f.handle.close).toHaveBeenCalledOnce();
  });
  it.each(["uid", "mount", "pid-namespace", "pid", "root", "proc", "proc-init"])("refuses %s before private path reads", kind => {
    const f = fixture();
    if (kind === "uid") f.state.uid = 10003;
    if (kind === "mount") f.state.mountNamespace = f.input.outerMountNamespace;
    if (kind === "pid-namespace") f.state.pidNamespace = f.input.outerPidNamespace;
    if (kind === "pid") f.state.pid = 2;
    if (kind === "root") f.state.rootType = 0;
    if (kind === "proc") f.state.procType = 0;
    if (kind === "proc-init") f.state.initNamespace = "pid:[3]";
    expect(() => readPrivateFixtureMirrorProof(f.input, f.io)).toThrow();
    expect(f.io.metadata).not.toHaveBeenCalled(); expect(f.io.open).not.toHaveBeenCalled();
  });
  it.each(["canonical", "owner", "hardlink", "mode", "symlink", "command"])("refuses %s input without opening SQLite", kind => {
    const f = fixture();
    if (kind === "canonical") f.state.realpath = "/outside/fixture";
    if (kind === "owner") f.state.owner = 10001;
    if (kind === "hardlink") f.state.links = 2;
    if (kind === "mode") f.state.mode = 0o622;
    if (kind === "symlink") f.state.symlink = true;
    if (kind === "command") f.input.commandId = "../unexpected";
    expect(() => readPrivateFixtureMirrorProof(f.input, f.io)).toThrow();
    expect(f.io.open).not.toHaveBeenCalled();
  });
  it("always closes the actual handle when proof extraction fails without exposing native text", () => {
    const f = fixture(); vi.mocked(readFixtureLocalMirrorProof).mockImplementationOnce(() => { throw new Error("private-error-prose"); });
    expect(() => readPrivateFixtureMirrorProof(f.input, f.io)).toThrow("fixture_inspection_failed");
    expect(f.handle.close).toHaveBeenCalledOnce();
  });
  it("turns a handle-close failure into a closed refusal rather than native error prose", () => {
    const f = fixture(); f.handle.close.mockImplementationOnce(() => { throw new Error("private-close-error-prose"); });
    expect(() => readPrivateFixtureMirrorProof(f.input, f.io)).toThrow("fixture_inspection_failed");
  });
});

describe("installed fixed-path mirror proof guards", () => {
  function installed() {
    const f = fixture(), active = fixtureDescriptor("a".repeat(64), "/sys/fs/cgroup/system.slice/zeros-host.service").active;
    const originalRoot = { pid: 8, startTimeTicks: 70, executable: `${active.root}/bin/node`, uid: 0, gid: 0, euid: 0, egid: 0,
      mountNamespace: "mnt:[44]", pidNamespace: "pid:[45]", procFilesystemType: 0x9fa0, cgroupFilesystemType: 0x63677270,
      cgroup: "0::/system.slice/zeros-host.service/host\n",
      service: { directory: active.cgroupRoot, dev: "43", ino: "101" },
      host: { directory: `${active.cgroupRoot}/host`, dev: "43", ino: "102" } };
    const metadata = { uid: 10003, gid: 10003, mode: 0o600, nlink: 1, dev: "43", ino: "501",
      isFile: () => true, isSymbolicLink: () => false };
    const io = { assertOriginal: vi.fn(), realpath: vi.fn(() => f.file), metadata: vi.fn(() => metadata), open: f.io.open };
    return { ...f, metadata, io, input: { active, originalRoot,
      handover: { schema: "zeros.installed-agent-e2e/v1" as const, sandboxId: "qualification-vm-only", active },
      activeRecordSha256: "c".repeat(64), scope: f.input.scope, commandId: f.input.commandId, conversationId: f.input.conversationId } };
  }
  it("uses original root/runtime checks before and after the actual read-only SQL proof and closes its handle", () => {
    const f = installed(); mirror.readInstalledFixtureMirrorProof(f.input, f.io);
    expect(f.io.assertOriginal).toHaveBeenCalledTimes(2);
    expect(f.io.open).toHaveBeenCalledExactlyOnceWith(f.file, { readonly: true, fileMustExist: true });
    expect(f.handle.close).toHaveBeenCalledOnce();
    expect(f.io.assertOriginal.mock.invocationCallOrder[0]).toBeLessThan(f.io.open.mock.invocationCallOrder[0]!);
    expect(f.handle.close.mock.invocationCallOrder[0]).toBeLessThan(f.io.assertOriginal.mock.invocationCallOrder[1]!);
    expect(f.io.metadata).toHaveBeenCalledTimes(2);
  });
  it("does not reuse a SOURCE private-namespace exemption or open after original custody refusal", () => {
    const f = installed(); f.io.assertOriginal.mockImplementation(() => { throw new Error("private original-custody detail"); });
    expect(() => mirror.readInstalledFixtureMirrorProof(f.input, f.io)).toThrow("fixture_inspection_failed");
    expect(f.io.metadata).not.toHaveBeenCalled(); expect(f.io.open).not.toHaveBeenCalled();
  });
  it.each(["owner", "gid", "hardlink", "mode", "symlink", "canonical", "command"])("refuses installed %s before SQLite open", kind => {
    const f = installed();
    if (kind === "owner") f.metadata.uid = 10001;
    if (kind === "gid") f.metadata.gid = 10001;
    if (kind === "hardlink") f.metadata.nlink = 2;
    if (kind === "mode") f.metadata.mode = 0o622;
    if (kind === "symlink") f.metadata.isSymbolicLink = () => true;
    if (kind === "canonical") f.io.realpath.mockReturnValue("/different/ledger.sqlite");
    if (kind === "command") f.input.commandId = "../unexpected";
    expect(() => mirror.readInstalledFixtureMirrorProof(f.input, f.io)).toThrow("fixture_inspection_failed");
    expect(f.io.open).not.toHaveBeenCalled();
  });
  it("rejects replacement of the ledger inode while closing the actual read-only handle", () => {
    const f = installed(); f.io.metadata.mockReturnValueOnce(f.metadata).mockReturnValueOnce({ ...f.metadata, ino: "502" });
    expect(() => mirror.readInstalledFixtureMirrorProof(f.input, f.io)).toThrow("fixture_inspection_failed");
    expect(f.handle.close).toHaveBeenCalledOnce();
  });
  it("withholds proof if original installation or root changes after extraction", () => {
    const f = installed(); f.io.assertOriginal.mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error("private changed pin"); });
    expect(() => mirror.readInstalledFixtureMirrorProof(f.input, f.io)).toThrow("fixture_inspection_failed");
    expect(f.handle.close).toHaveBeenCalledOnce();
  });
  it.each(["query", "close"])("keeps %s failure closed", kind => {
    const f = installed();
    if (kind === "query") vi.mocked(readFixtureLocalMirrorProof).mockImplementationOnce(() => { throw new Error("private SQL data"); });
    else f.handle.close.mockImplementationOnce(() => { throw new Error("private close data"); });
    expect(() => mirror.readInstalledFixtureMirrorProof(f.input, f.io)).toThrow("fixture_inspection_failed");
    expect(f.handle.close).toHaveBeenCalledOnce();
  });
});
