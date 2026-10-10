import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  close: vi.fn(),
  statFailure: false,
  filesystemFailure: false,
  overflowAncestor: false,
  forgedAncestor: false,
}));
vi.mock("node:fs", () => ({
  constants: { O_NOFOLLOW: 1, O_RDONLY: 2, O_WRONLY: 4 },
  closeSync: calls.close,
  chmodSync: vi.fn(),
  openSync: () => 31,
  lstatSync: (file: string) => {
    if (file === "/etc/zeros/cloud-worker.json") throw Object.assign(new Error("absent marker"), {code:"ENOENT"});
    return {
    isDirectory: () => true,
    isSymbolicLink: () => false,
    uid: calls.overflowAncestor && ["/sys", "/sys/fs"].includes(file) ? 65534 : 0,
    mode: 0o700,
    };
  },
  fstatSync: () => {
    if (calls.statFailure) throw new Error("stat failed");
    return { isFile: () => true, uid: 0, mode: 0o600 };
  },
  statfsSync: (file: string) => {
    if (file.startsWith("/proc/self/fd/") && calls.filesystemFailure)
      throw new Error("filesystem inspection failed");
    return { type: calls.overflowAncestor && ["/sys", "/sys/fs"].includes(file) ? (calls.forgedAncestor ? 0x794c7630 : 0x62656572) : 0x63677270 };
  },
  realpathSync: (file: string) => file,
  mkdirSync: vi.fn(),
  rmdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  // The nested engine leaf checks native UID/GID before opening cgroup.procs.
  // Keep that observation separate from the original descriptor failures.
  readFileSync: (file: string, encoding: string) => {
    if (file !== "/proc/123/status" || encoding !== "utf8")
      throw new Error("Unexpected native cgroup fixture read");
    return "Uid:\t10003\t10003\t10003\t10003\nGid:\t10003\t10003\t10003\t10003\n";
  },
  readSync: vi.fn((_fd: number, buffer: Buffer, offset: number) => offset ? 0 : Buffer.from("populated 0\n").copy(buffer)),
  writeSync: vi.fn((_fd: number, value: string) => Buffer.byteLength(value)),
}));
import { CloudEngineCgroup } from "../cloud-workspace-validation/sandbox/cloud-engine-cgroup.mjs";
import { testCloudRuntime } from "../../apps/desktop/src/engine/agents/__tests__/helpers/test-cloud-runtime";
const scope = () => new CloudEngineCgroup({ runtime: testCloudRuntime(), instanceId: "32345678-1234-4234-8234-123456789abc" });

describe("cgroup descriptor failure cleanup", () => {
  beforeEach(() => {
    calls.close.mockClear();
    calls.statFailure = false;
    calls.filesystemFailure = false;
    calls.overflowAncestor = false;
    calls.forgedAncestor = false;
  });
  it("retires a delegated root-owned cgroup below kernel-owned sysfs ancestors", async () => {
    calls.overflowAncestor = true;
    const uid = vi.spyOn(process, "getuid").mockReturnValue(0);
    try { await expect(scope().retire()).resolves.toBeUndefined(); }
    finally { uid.mockRestore(); }
  });
  it("does not trust an overflow-owned ancestor on an ordinary filesystem", async () => {
    calls.overflowAncestor = true; calls.forgedAncestor = true;
    const uid = vi.spyOn(process, "getuid").mockReturnValue(0);
    try { await expect(scope().retire()).rejects.toThrow(/ancestry/); }
    finally { uid.mockRestore(); }
  });
  it("closes a descriptor when inode inspection fails", () => {
    calls.statFailure = true;
    expect(() => scope().attach(123)).toThrow(/stat failed/);
    expect(calls.close).toHaveBeenCalledWith(31);
  });
  it("closes a descriptor when filesystem inspection fails", () => {
    calls.filesystemFailure = true;
    expect(() => scope().attach(123)).toThrow(
      /filesystem inspection failed/,
    );
    expect(calls.close).toHaveBeenCalledWith(31);
  });
});
