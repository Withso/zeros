import { chmodSync, rmSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createCloudRuntimeResolver } from "../cloud-runtime-root.mjs";
import { cloudRuntimeAssetEnvironment } from "../cloud-runtime-assets.mjs";
import { cloudRuntimeFixture } from "./cloud-runtime-fixture";

describe("runtime LFS/font admission", () => {
  it("leaves non-v4 environments unchanged and binds v4 assets to the exact selected pin", () => {
    expect(cloudRuntimeAssetEnvironment({ profile: "legacy", workerRoot: "/legacy" })).toEqual({});
    for (const workerRoot of ["/runtime/one/worker", "/runtime/two/worker"])
      expect(cloudRuntimeAssetEnvironment({ profile: "v4", workerRoot })).toEqual({
        GIT_CONFIG_SYSTEM: `${workerRoot}/gitconfig`, FONTCONFIG_FILE: `${workerRoot}/design-fonts/fonts.conf`,
        GIT_EXEC_PATH: `/opt/zeros-infra/.git-exec/${workerRoot.split("/").at(-2)}`,
        FONTCONFIG_PATH: `${workerRoot}/design-fonts`,
      });
  });
  it("reads child asset metadata under the inherited read-only unmapped-root policy", async () => {
    const tree = cloudRuntimeFixture();
    try {
      tree.write("/proc/self/uid_map", "10003 10003 1\n");
      tree.write("/proc/self/gid_map", "10003 10003 1\n");
      tree.owners.set(`${tree.descriptor.root}/worker/runtime-system-assets.json`, 65534);
      vi.resetModules();
      vi.doMock("node:fs", async () => {
        const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
        return { ...actual,
          openSync: (file: string, flags: number) => actual.openSync(
            /^\/proc\/self\/(?:uid|gid)_map$/.test(file) ? tree.physical(file) : file, flags),
          statfsSync: () => ({ type: 0x9fa0 }),
        };
      });
      const { createCloudRuntimeResolver: childResolver } = await import("../cloud-runtime-root.mjs");
      const resolve = (readOnly: boolean) => childResolver({ filesystem: tree.filesystem,
        isOwner: (_file: string, uid: number) => uid === 0, isReadOnly: () => readOnly,
        executable: () => `${tree.descriptor.root}/bin/node` }).resolveChild();
      expect(resolve(true).root).toBe(tree.descriptor.root);
      expect(() => resolve(false)).toThrow(/system assets/);
    } finally { vi.doUnmock("node:fs"); vi.resetModules(); tree.dispose(); }
  });
  it.each(["bin/git-lfs", "worker/gitconfig", "worker/design-fonts/fonts.conf", "worker/runtime-system-assets.json"])(
    "explicitly refuses a missing %s before cloud execution", file => {
      const tree = cloudRuntimeFixture();
      try {
        rmSync(tree.physical(`${tree.descriptor.root}/${file}`), { force: true });
        expect(() => createCloudRuntimeResolver({ filesystem: tree.filesystem }).resolve()).toThrow(/system assets/);
      } finally { tree.dispose(); }
    });
  it("refuses a nonexecutable LFS binary and an escaping font inventory", () => {
    const tree = cloudRuntimeFixture();
    try {
      const root = tree.descriptor.root;
      tree.write(`${root}/bin/git-lfs`, "fixture", 0o444);
      expect(() => createCloudRuntimeResolver({ filesystem: tree.filesystem }).resolve()).toThrow(/system assets/);
      chmodSync(tree.physical(`${root}/bin/git-lfs`), 0o555);
      tree.write(`${root}/worker/runtime-system-assets.json`, { schema: "zeros.runtime-system-assets/v1",
        gitLfs: "bin/git-lfs", gitConfig: "worker/gitconfig", fontConfig: "worker/design-fonts/fonts.conf", fonts: ["../outside"] });
      expect(() => createCloudRuntimeResolver({ filesystem: tree.filesystem }).resolve()).toThrow(/system assets/);
    } finally { tree.dispose(); }
  });
});
