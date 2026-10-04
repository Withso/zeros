import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  stageDependencyClosure,
  scanPayload,
  RUNTIME_HELPERS,
} from "../cloud-workspace-validation/runtime-bundle/closure";
import { inventoryTree } from "../cloud-workspace-validation/runtime-bundle/manifest";

const temporary: string[] = [];
async function directory() {
  const root = await mkdtemp(path.join(os.tmpdir(), "zeros-closure-unit-"));
  temporary.push(root);
  return root;
}
async function json(filename: string, value: unknown) {
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, JSON.stringify(value));
}
async function link(from: string, to: string) {
  await mkdir(path.dirname(to), { recursive: true });
  await symlink(path.relative(path.dirname(to), from), to);
}
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("pnpm runtime closure", () => {
  it("retains production, peer, optional and workspace edges, terminates cycles, and regenerates relocatable shims", async () => {
    const temp = await directory(),
      source = path.join(temp, "source"),
      runtime = path.join(temp, "runtime");
    const a = path.join(source, "node_modules/.pnpm/a@1/node_modules/a");
    const b = path.join(source, "node_modules/.pnpm/b@1/node_modules/b");
    const peer = path.join(
      source,
      "node_modules/.pnpm/peer@1/node_modules/peer",
    );
    const workspace = path.join(source, "packages/library");
    await json(path.join(source, "package.json"), {
      dependencies: { a: "1", library: "workspace:*" },
      devDependencies: { unused: "1" },
    });
    await json(path.join(a, "package.json"), {
      name: "a",
      version: "1.0.0",
      dependencies: { b: "1" },
      peerDependencies: { peer: "1" },
      bin: { cli: "cli.js" },
    });
    await writeFile(
      path.join(a, "cli.js"),
      "#!/usr/bin/env node\nconsole.log('ok');\n",
    );
    await json(path.join(b, "package.json"), {
      name: "b",
      version: "1.0.0",
      dependencies: { a: "1" },
      optionalDependencies: { missing: "1" },
    });
    await json(path.join(peer, "package.json"), {
      name: "peer",
      version: "1.0.0",
    });
    await json(path.join(workspace, "package.json"), {
      name: "library",
      version: "1.0.0",
      dependencies: { b: "1" },
    });
    await link(a, path.join(source, "node_modules/a"));
    await link(workspace, path.join(source, "node_modules/library"));
    await link(b, path.join(path.dirname(a), "b"));
    await link(peer, path.join(path.dirname(a), "peer"));
    await link(a, path.join(path.dirname(b), "a"));
    await link(b, path.join(workspace, "node_modules/b"));
    await mkdir(path.join(source, "node_modules/.bin"), { recursive: true });
    await writeFile(
      path.join(source, "node_modules/.bin/cli"),
      `original absolute shim: ${source}`,
    );
    const packages = await stageDependencyClosure(source, runtime, {
      harnessRoots: [],
    });
    expect(packages.map((pkg) => pkg.name).sort()).toEqual([
      "a",
      "b",
      "library",
      "peer",
    ]);
    const worker = path.join(runtime, "worker");
    expect(await readlink(path.join(worker, "node_modules/a"))).toBe(
      ".pnpm/a@1/node_modules/a",
    );
    expect(await readlink(path.join(worker, "node_modules/library"))).toBe(
      "../packages/library",
    );
    expect(
      (
        await lstat(
          path.join(worker, "node_modules/.pnpm/a@1/node_modules/a/cli.js"),
        )
      ).nlink,
    ).toBe(1);
    const shim = await readFile(
      path.join(worker, "node_modules/.bin/cli"),
      "utf8",
    );
    expect(shim).not.toContain(source);
    expect(shim).not.toContain("NODE_PATH");
    expect(shim).toContain("../../../bin/node");
    await mkdir(path.join(runtime, "bin"));
    await writeFile(
      path.join(runtime, "bin/node"),
      '#!/bin/sh\nprintf "%s\\n" "$1"\n',
      { mode: 0o555 },
    );
    await rm(source, { recursive: true });
    const relocated = path.join(temp, "relocated");
    await rename(runtime, relocated);
    const target = execFileSync(
      path.join(relocated, "worker/node_modules/.bin/cli"),
      { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } },
    ).trim();
    expect(path.resolve(target)).toBe(
      path.join(
        relocated,
        "worker/node_modules/.pnpm/a@1/node_modules/a/cli.js",
      ),
    );
    await expect(inventoryTree(relocated)).resolves.toBeTruthy();
  });

  it("fails on missing required dependencies and external package targets", async () => {
    const temp = await directory(),
      source = path.join(temp, "source");
    await json(path.join(source, "package.json"), {
      dependencies: { missing: "1" },
    });
    await expect(
      stageDependencyClosure(source, path.join(temp, "one"), {
        harnessRoots: [],
      }),
    ).rejects.toThrow(/dependency_missing/);
    await json(path.join(temp, "external/package.json"), {
      name: "missing",
      version: "1.0.0",
    });
    await link(
      path.join(temp, "external"),
      path.join(source, "node_modules/missing"),
    );
    await expect(
      stageDependencyClosure(source, path.join(temp, "two"), {
        harnessRoots: [],
      }),
    ).rejects.toThrow(/dependency_external/);
  });

  it("rejects installed packages for another CPU or OS", async () => {
    const temp = await directory(),
      source = path.join(temp, "source");
    await json(path.join(source, "package.json"), {
      dependencies: { wrong: "1" },
    });
    await json(path.join(source, "node_modules/wrong/package.json"), {
      name: "wrong",
      version: "1.0.0",
      os: ["darwin"],
      cpu: ["arm64"],
    });
    await expect(
      stageDependencyClosure(source, path.join(temp, "runtime"), {
        harnessRoots: [],
      }),
    ).rejects.toThrow(/native_platform/);
  });

  it("has one helper inventory matching all 19 legacy helpers plus optional future entries", async () => {
    const legacy = await readFile(
      "scripts/cloud-workspace-validation/boat-image/templates/build.sh",
      "utf8",
    );
    const names = /for name in (.*); do/.exec(legacy)![1].split(" ");
    expect(
      RUNTIME_HELPERS.filter(
        (entry) =>
          !entry.optional && entry.target.endsWith(".apparmor") === false,
      ).map((entry) => path.basename(entry.target)),
    ).toEqual(names);
    expect(
      RUNTIME_HELPERS.some(
        (entry) =>
          entry.optional && entry.target === "lib/zeros/cloud-runtime-root.mjs",
      ),
    ).toBe(true);
    expect(
      RUNTIME_HELPERS.some(
        (entry) =>
          entry.optional && entry.target === "lib/zeros/runtime-self-test.mjs",
      ),
    ).toBe(true);
  });
});

describe("payload hygiene", () => {
  it("rejects host paths even across scan chunks, without exposing contents", async () => {
    const root = await directory();
    await writeFile(
      path.join(root, "binary"),
      Buffer.concat([
        Buffer.alloc(65530),
        Buffer.from("/private/build-path/hidden"),
      ]),
    );
    await expect(scanPayload(root, ["/private/build-path"])).rejects.toThrow(
      /^build_path$/,
    );
  });
  it("rejects token-shaped data and forbidden names without printing the match", async () => {
    const root = await directory();
    const body = "abcdefghijklmnopqrstuvwxyz0123456789";
    await writeFile(path.join(root, "token"), ["gh", "p_", body].join(""));
    await expect(scanPayload(root, [])).rejects.toThrow(/^secret_shape$/);
    await rm(path.join(root, "token"));
    await writeFile(path.join(root, ".env.example"), "placeholder");
    await expect(scanPayload(root, [])).rejects.toThrow(/^forbidden_payload$/);
  });
  it("allows credential pattern definitions, digests and low-entropy test placeholders", async () => {
    const root = await directory();
    await writeFile(
      path.join(root, "patterns"),
      ["gh[pous]_[A-Za-z0-9]{36}", "a".repeat(64), "sk-" + "x".repeat(48)].join(
        "\n",
      ),
    );
    await chmod(path.join(root, "patterns"), 0o444);
    await expect(scanPayload(root, [])).resolves.toBeUndefined();
  });
});

// Opt-in real-build acceptance. The normal unit suite never downloads or builds.
// Run with ZEROS_RUNTIME_BUNDLE_TEST_DIR=<outDir> after the builder succeeds.
describe.skipIf(!process.env.ZEROS_RUNTIME_BUNDLE_TEST_DIR)(
  "extracted Linux archive closure",
  () => {
    it("checks the descriptor, every file hash and offline probes with no checkout or store", async () => {
      const { verifyBundleDirectory } =
        await import("../cloud-workspace-validation/runtime-bundle/verify");
      const result = await verifyBundleDirectory(
        path.resolve(process.env.ZEROS_RUNTIME_BUNDLE_TEST_DIR!),
        true,
      );
      expect(result.closure?.checks).toContain("engine_help");
      expect(result.closure?.checks).toContain("sqlite_query");
      expect(result.closure?.checks).toContain("pty_load");
      expect(result.closure?.checks).toContain("claude_version");
      expect(result.closure?.checks).toContain("codex_version");
      expect(result.closure?.checks).toContain("cursor_load");
    }, 300_000);
  },
);
