import { expect, it } from "vitest";
import { compileDesignSass } from "../style-sass";
import { build } from "esbuild";
import { mkdtemp, copyFile, rm, mkdir, symlink, cp, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

it("terminates a non-terminating Sass program and permits the next compilation", async () => {
  const read = async () => null;
  const started = Date.now();
  await expect(compileDesignSass({ file: "style.scss", content: "@while true {}" }, read, {
    executionTimeoutMs: 100,
  })).rejects.toThrow(/time|budget/i);
  expect(Date.now() - started).toBeLessThan(10_000);
  expect((await compileDesignSass({ file: "style.scss", content: ".safe { width: 1px; }" }, read)).css).toContain("width: 1px");
}, 15_000);

it("loads the shipped compiler outside asar in the owned Node process", async () => {
  const require = createRequire(import.meta.url);
  const builder = createRequire(require.resolve("electron-builder"));
  const appBuilder = createRequire(builder.resolve("app-builder-lib"));
  const { createPackageWithOptions } = appBuilder("@electron/asar");
  const { load } = appBuilder("js-yaml");
  const packaging = load(await readFile(path.resolve("electron-builder.yml"), "utf8")) as { asarUnpack: string[] };
  const directory = await mkdtemp(path.join(os.tmpdir(), "zeros-sass-packaged-"));
  const source = path.join(directory, "source"), resources = path.join(directory, "Resources");
  const names = ["ZEROS_SASS_HOST_SCRIPT", "ZEROS_SASS_MODULE", "ZEROS_PTY_HOST_RUNTIME", "ZEROS_PTY_HOST_RUNTIME_ELECTRON"] as const;
  const previous = names.map(name => process.env[name]);
  try {
    await mkdir(path.join(source, "node_modules"), { recursive: true });
    await mkdir(resources);
    const sass = require.resolve("sass");
    const immutable = createRequire(sass).resolve("immutable/package.json");
    await cp(path.dirname(sass), path.join(source, "node_modules/sass"), { recursive: true });
    await cp(path.dirname(immutable), path.join(source, "node_modules/immutable"), { recursive: true });
    await createPackageWithOptions(source, path.join(resources, "app.asar"), { unpack: `{${packaging.asarUnpack.join(",")}}` });
    await copyFile(path.resolve(import.meta.dirname, "../sass-host.cjs"), path.join(resources, "sass-host.cjs"));
    // Electron main resolves this archived path. Its Node-mode child has no
    // asar filesystem, so the real compiler and its dependencies must be unpacked.
    process.env.ZEROS_SASS_HOST_SCRIPT = path.join(resources, "sass-host.cjs");
    process.env.ZEROS_SASS_MODULE = path.join(resources, "app.asar/node_modules/sass/sass.node.js");
    process.env.ZEROS_PTY_HOST_RUNTIME = process.execPath;
    delete process.env.ZEROS_PTY_HOST_RUNTIME_ELECTRON;
    const result = await compileDesignSass({ file: "style.scss", content: ".packaged { width: 7px; }" }, async () => null);
    expect(result.css).toContain("width: 7px");
  } finally {
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    });
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

it("rejects an oversized entry before launching any compilation", async () => {
  await expect(compileDesignSass({ file: "style.scss", content: " ".repeat(2 * 1024 * 1024 + 1) }, async () => null)).rejects.toThrow(/budget|large/i);
});

it("uses its own compiler asset from a CommonJS bundle independently of the workspace", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zeros-sass-bundle-"));
  const output = path.join(directory, "compiler.cjs"), workspace = path.join(directory, "workspace");
  try {
    await mkdir(workspace);
    await symlink(path.resolve("node_modules"), path.join(directory, "node_modules"), "dir");
    await copyFile(path.resolve(import.meta.dirname, "../sass-host.cjs"), path.join(directory, "sass-host.cjs"));
    await build({ entryPoints: [path.resolve(import.meta.dirname, "../style-sass.ts")], outfile: output, bundle: true, format: "cjs", platform: "node", logLevel: "silent" });
    const source = `require(${JSON.stringify(output)}).compileDesignSass({file:"style.scss",content:".safe { width: 3px; }"},async()=>null).then(result=>process.stdout.write(result.css)).catch(()=>process.exit(1));`;
    const result = await promisify(execFile)(process.execPath, ["-e", source], { cwd: workspace, env: {}, timeout: 10_000 });
    expect(result.stdout).toContain("width: 3px");
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 15_000);
