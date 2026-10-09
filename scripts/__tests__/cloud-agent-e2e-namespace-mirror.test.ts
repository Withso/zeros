// Private-view filesystem/SQLite ports are synthetic here; no namespace or
// provider qualification is inferred from these guard regressions.
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { readPrivateFixtureMirrorProof } from "../cloud-workspace-validation/cloud-agent-e2e/namespace-mirror-proof";
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
