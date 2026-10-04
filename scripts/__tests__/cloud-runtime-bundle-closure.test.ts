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
  stageSources,
  scanPayload,
  RUNTIME_HELPERS,
  ROOT_METADATA,
  SOURCE_SLICES,
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

  it("rejects a package bin symlink before chmod can follow it outside R", async () => {
    const temp = await directory(),
      source = path.join(temp, "source");
    await json(path.join(source, "package.json"), { dependencies: { a: "1" } });
    const pkg = path.join(source, "node_modules/a");
    await json(path.join(pkg, "package.json"), {
      name: "a",
      version: "1.0.0",
      bin: { a: "cli.js" },
    });
    const outside = path.join(temp, "external.js");
    await writeFile(outside, "#!/usr/bin/env node\n", { mode: 0o444 });
    await symlink(outside, path.join(pkg, "cli.js"));
    await expect(
      stageDependencyClosure(source, path.join(temp, "runtime"), {
        harnessRoots: [],
      }),
    ).rejects.toThrow(/symlink_escape/);
    expect((await lstat(outside)).mode & 0o777).toBe(0o444);
  });

  it("retains declared npm dependencies whose names also name Node built-ins", async () => {
    const temp = await directory(),
      source = path.join(temp, "source");
    await json(path.join(source, "package.json"), {
      dependencies: { buffer: "1" },
    });
    await json(path.join(source, "node_modules/buffer/package.json"), {
      name: "buffer",
      version: "1.0.0",
    });
    const packages = await stageDependencyClosure(
      source,
      path.join(temp, "runtime"),
      { harnessRoots: [] },
    );
    expect(packages.map((entry) => entry.name)).toEqual(["buffer"]);
  });

  it("keeps rebuilt PTY and vendor notices without non-Linux PTY/SSH helpers", async () => {
    const temp = await directory(),
      source = path.join(temp, "source");
    await json(path.join(source, "package.json"), {
      dependencies: { "node-pty": "1.1.0", ssh2: "1.17.0" },
    });
    const pkg = path.join(source, "node_modules/node-pty");
    await json(path.join(pkg, "package.json"), {
      name: "node-pty",
      version: "1.1.0",
    });
    for (const name of [
      "build/Release/pty.node",
      "prebuilds/win32-x64/pty.node",
      "third_party/conpty/LICENSE",
      "third_party/conpty/win10-arm64/OpenConsole.exe",
      "third_party/conpty/win10-x64/conpty.dll",
    ]) {
      await mkdir(path.dirname(path.join(pkg, name)), { recursive: true });
      await writeFile(path.join(pkg, name), "fixture");
    }
    const ssh = path.join(source, "node_modules/ssh2");
    await json(path.join(ssh, "package.json"), {
      name: "ssh2",
      version: "1.17.0",
    });
    await mkdir(path.join(ssh, "util"));
    await writeFile(path.join(ssh, "util/pagent.exe"), "fixture");
    await writeFile(path.join(ssh, "LICENSE"), "fixture license");
    const runtime = path.join(temp, "runtime");
    await stageDependencyClosure(source, runtime, { harnessRoots: [] });
    const entries = (await inventoryTree(runtime)).map((entry) => entry.path);
    expect(entries).toContain(
      "worker/node_modules/node-pty/build/Release/pty.node",
    );
    expect(entries).toContain(
      "worker/node_modules/node-pty/third_party/conpty/LICENSE",
    );
    expect(entries).toContain("worker/node_modules/ssh2/LICENSE");
    expect(
      entries.some(
        (name) => /\.(exe|dll)$/.test(name) || name.includes("prebuilds/"),
      ),
    ).toBe(false);
  });

  it("omits upstream credential examples and test keys while retaining notices", async () => {
    const temp = await directory(),
      source = path.join(temp, "source");
    await json(path.join(source, "package.json"), {
      dependencies: { "@octokit/auth-token": "6", ssh2: "1", zod: "4" },
    });
    const example = ["gh", "p_", "abcdefghijklmnopqrstuvwxyz0123456789"].join(
      "",
    );
    for (const [name, relative] of [
      ["@octokit/auth-token", "README.md"],
      ["ssh2", "test/fixtures/key"],
      ["zod", "src/v4/mini/tests/string.test.ts"],
    ]) {
      const pkg = path.join(source, "node_modules", name);
      await json(path.join(pkg, "package.json"), {
        name,
        version: "1.0.0",
        license: "MIT",
      });
      await mkdir(path.dirname(path.join(pkg, relative)), { recursive: true });
      await writeFile(path.join(pkg, relative), example);
      await writeFile(path.join(pkg, "LICENSE"), "Unmodified upstream license");
    }
    const runtime = path.join(temp, "runtime");
    await stageDependencyClosure(source, runtime, { harnessRoots: [] });
    await expect(scanPayload(runtime, [])).resolves.toBeUndefined();
    const entries = await inventoryTree(runtime);
    expect(
      entries.filter((entry) => entry.path.endsWith("/LICENSE")),
    ).toHaveLength(3);
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

  it("matches the legacy helper set with a required runtime-root resolver and optional self-test", async () => {
    const legacy = await readFile(
      "scripts/cloud-workspace-validation/boat-image/templates/build.sh",
      "utf8",
    );
    const names = /for name in (.*); do/.exec(legacy)![1].split(" ");
    expect(
      RUNTIME_HELPERS.filter(
        (entry) =>
          !entry.optional && entry.target.endsWith(".apparmor") === false,
      )
        .map((entry) => path.basename(entry.target))
        .sort(),
    ).toEqual(names.sort());
    expect(RUNTIME_HELPERS).toContainEqual({
      source:
        "apps/desktop/src/engine/agents/containment/cloud-runtime-root.mjs",
      target: "lib/zeros/cloud-runtime-root.mjs",
      optional: false,
    });
    expect(
      RUNTIME_HELPERS.some(
        (entry) =>
          entry.optional && entry.target === "lib/zeros/runtime-self-test.mjs",
      ),
    ).toBe(true);
  });

  it("stages the runtime-root resolver as a standalone regular file and fails if its source is absent", async () => {
    const temp = await directory(),
      source = path.join(temp, "source"),
      runtime = path.join(temp, "runtime");
    const resolverSource =
      "apps/desktop/src/engine/agents/containment/cloud-runtime-root.mjs";
    const contents = await readFile(resolverSource);
    for (const relative of SOURCE_SLICES)
      await mkdir(path.join(source, relative), { recursive: true });
    for (const relative of [
      ...ROOT_METADATA,
      ...RUNTIME_HELPERS.filter((entry) => !entry.optional).map(
        (entry) => entry.source,
      ),
      "scripts/cloud-workspace-validation/sandbox/start-engine.sh",
    ]) {
      const filename = path.join(source, relative);
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(filename, "fixture");
    }
    await mkdir(path.dirname(path.join(source, resolverSource)), {
      recursive: true,
    });
    await writeFile(path.join(source, resolverSource), contents);
    await link(
      path.join(source, resolverSource),
      path.join(
        source,
        "scripts/cloud-workspace-validation/sandbox/cloud-runtime-root.mjs",
      ),
    );
    await stageSources(source, runtime);
    const resolver = path.join(runtime, "lib/zeros/cloud-runtime-root.mjs");
    expect(await readFile(resolver)).toEqual(contents);
    expect((await lstat(resolver)).nlink).toBe(1);
    expect(await inventoryTree(runtime)).toContainEqual(
      expect.objectContaining({
        path: "lib/zeros/cloud-runtime-root.mjs",
        type: "file",
        mode: "0555",
        size: contents.length,
      }),
    );
    await rm(path.join(source, resolverSource));
    await expect(
      stageSources(source, path.join(temp, "missing-resolver")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await rm(source, { recursive: true });
    expect(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          'import { pathToFileURL } from "node:url"; const resolver = await import(pathToFileURL(process.argv[1]).href); process.stdout.write(String(resolver.cloudProfileIdentityMapVersion(4)));',
          resolver,
        ],
        { cwd: runtime, env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" },
      ),
    ).toBe("3");
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
  it("does not mistake compiled format strings or adjacent provider prefixes for tokens", async () => {
    const root = await directory();
    const symbols = [
      "gh",
      "p_",
      "a_format_string_with_underscores_and_no_credential",
    ].join("");
    const prefixes = [
      "sk-",
      "proj-",
      "sk-",
      "svcacct-",
      "sk-",
      "OPENAI_API_KEY",
      "field",
    ].join("");
    await writeFile(
      path.join(root, "binary"),
      Buffer.from(`\0${symbols}\0${prefixes}\0`),
    );
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
      const directory = path.resolve(
        process.env.ZEROS_RUNTIME_BUNDLE_TEST_DIR!,
      );
      const result = await verifyBundleDirectory(directory, true);
      const receipt = JSON.parse(
        await readFile(path.join(directory, "build-receipt.json"), "utf8"),
      );
      expect(receipt.fileCount).toBe(
        result.manifest.files.filter((entry) => entry.type === "file").length,
      );
      expect(receipt.entryCount).toBe(result.manifest.files.length);
      expect(receipt.fileCount).toBeLessThan(receipt.entryCount);
      expect(result.manifest.files).toContainEqual(
        expect.objectContaining({
          path: "lib/zeros/cloud-runtime-root.mjs",
          type: "file",
          mode: "0555",
        }),
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
