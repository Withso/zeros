import { describe, expect, it, vi } from "vitest";
import { prepareCloudEngineAppArmor } from "../cloud-workspace-validation/sandbox/cloud-engine-launcher.mjs";

function fixture(value = "1") {
  return {
    read: vi.fn((file: string) => Buffer.from(file === "/proc/self/uid_map" ? "0 0 4294967295\n" : value)),
    verify: vi.fn(),
    execute: vi.fn(() => ({ status: 0, signal: null })),
  };
}

describe("cloud application-scoped user namespaces", () => {
  it("does not attempt to change host AppArmor policy from a provider user namespace", () => {
    const f = fixture();
    f.read.mockImplementation(file => Buffer.from(file === "/proc/self/uid_map" ? "0 951968 65536\n" : "1\n"));
    prepareCloudEngineAppArmor(f);
    expect(f.execute).not.toHaveBeenCalled(); expect(f.verify).not.toHaveBeenCalled();
  });
  it("rejects an invalid kernel identity map instead of assuming a provider namespace", () => {
    const f = fixture();
    f.read.mockImplementation(file => Buffer.from(file === "/proc/self/uid_map" ? "invalid\n" : "1\n"));
    expect(() => prepareCloudEngineAppArmor(f)).toThrow(/identity map/);
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("loads only the fixed image-owned profile when the kernel requires it", () => {
    const f = fixture();
    prepareCloudEngineAppArmor(f);
    expect(f.read).toHaveBeenCalledWith(
      "/proc/sys/kernel/apparmor_restrict_unprivileged_userns",
      32,
    );
    expect(f.verify.mock.calls).toEqual([
      ["/usr/sbin/apparmor_parser"],
      ["/opt/zeros-runtime/lib/zeros/zeros-cloud-engine.apparmor"],
    ]);
    expect(f.execute).toHaveBeenCalledWith(
      "/usr/sbin/apparmor_parser",
      [
        "--replace",
        "--skip-cache",
        "/opt/zeros-runtime/lib/zeros/zeros-cloud-engine.apparmor",
      ],
      expect.objectContaining({
        timeout: 10000,
        env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C" },
      }),
    );
  });

  it.each(["0", "0\n"])(
    "needs no host-policy mutation when restriction is %j",
    (value) => {
      const f = fixture(value);
      prepareCloudEngineAppArmor(f);
      expect(f.execute).not.toHaveBeenCalled();
    },
  );

  it("permits kernels without the optional AppArmor restriction", () => {
    const f = fixture();
    f.read.mockImplementation(() => {
      throw Object.assign(new Error("absent"), { code: "ENOENT" });
    });
    prepareCloudEngineAppArmor(f);
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("fails closed on unknown, unreadable, unsafe, or rejected policy", () => {
    expect(() => prepareCloudEngineAppArmor(fixture("unknown"))).toThrow();
    const unreadable = fixture();
    unreadable.read.mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });
    expect(() => prepareCloudEngineAppArmor(unreadable)).toThrow();
    const unsafe = fixture();
    unsafe.verify.mockImplementation(() => {
      throw new Error("unsafe path");
    });
    expect(() => prepareCloudEngineAppArmor(unsafe)).toThrow(/unsafe/);
    expect(unsafe.execute).not.toHaveBeenCalled();
    const failed = fixture();
    failed.execute.mockReturnValue({ status: 1, signal: null });
    expect(() => prepareCloudEngineAppArmor(failed)).toThrow(/profile/);
  });
});
