import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const repository = resolve(root, "../..");
const external = ["node-pty", "@openai/codex", "@anthropic-ai/claude-agent-sdk", "@cursor/sdk"];
const sourcePackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const request = createRequire(join(root, "package.json"));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--outdir")) throw new Error("Usage: build.mjs [--outdir directory]");
if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch) || Number(process.versions.node.split(".")[0]) !== 24)
  throw new Error("Build the worker on Linux with Node 24, matching the VM architecture.");
const output = resolve(args[1] ?? join(root, "dist"));
if (output !== join(root, "dist") && (output === repository || output.startsWith(repository + sep)))
  throw new Error("Custom build output must be outside the source checkout.");
const previous = await lstat(output).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
if (previous) {
  const manifest = await readFile(join(output, "package.json"), "utf8").then(JSON.parse, () => ({}));
  if (!previous.isDirectory() || previous.isSymbolicLink() || manifest.name !== sourcePackage.name)
    throw new Error("Refusing to replace an output directory that is not a worker build.");
}
await mkdir(dirname(output), { recursive: true });
const staging = await mkdtemp(join(dirname(output), ".worker-build-"));
const installed = new Map();
const packages = {};
const pins = {};

async function manifestFor(name, from) {
  try { return await realpath(from.resolve(`${name}/package.json`)); } catch { /* Some exports omit package.json. */ }
  let current = dirname(from.resolve(name));
  while (current !== dirname(current)) {
    try {
      const path = join(current, "package.json");
      const manifest = JSON.parse(await readFile(path, "utf8"));
      if (typeof manifest.name === "string") return await realpath(path);
    } catch { /* Continue past intermediate module-format manifests. */ }
    current = dirname(current);
  }
  throw new Error(`Cannot locate runtime package ${name}.`);
}

function supported(manifest) {
  const accepts = (list, value) => !list || ((!list.some(v => !v.startsWith("!")) || list.includes(value)) && !list.includes(`!${value}`));
  return accepts(manifest.os, process.platform) && accepts(manifest.cpu, process.arch) && accepts(manifest.libc, "glibc");
}

/** Materialize npm's actual installed dependency graph. A flat package is
 * reused only for the same source; conflicting versions stay nested. No pnpm
 * store links or ancestor checkout resolution may survive into the image. */
async function install(name, manifestPath, parent = staging) {
  const source = dirname(manifestPath);
  let existing;
  for (let cursor = parent; cursor === staging || cursor.startsWith(staging + sep); cursor = dirname(cursor)) {
    const candidate = join(cursor, "node_modules", name);
    if (installed.has(candidate)) { existing = candidate; break; }
    if (cursor === staging) break;
  }
  if (existing && installed.get(existing) === source) return;
  const destination = join(existing ? parent : staging, "node_modules", name);
  if (installed.has(destination)) throw new Error(`Conflicting runtime package ${name}.`);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!supported(manifest)) throw new Error(`Runtime package ${name} targets another platform.`);
  installed.set(destination, source);
  packages[relative(staging, destination)] = { name, version: manifest.version, license: manifest.license ?? "SEE PACKAGE LICENSE" };
  await cp(source, destination, { recursive: true, dereference: true, mode: constants.COPYFILE_FICLONE,
    filter: path => relative(source, path).split(sep).every(part => part !== "node_modules" && part !== ".git"),
  });
  const from = createRequire(manifestPath);
  const dependencies = { ...manifest.peerDependencies, ...manifest.dependencies, ...manifest.optionalDependencies };
  for (const dependency of Object.keys(dependencies).sort()) {
    const optional = dependency in (manifest.optionalDependencies ?? {}) || manifest.peerDependenciesMeta?.[dependency]?.optional;
    let dependencyPath;
    try { dependencyPath = await manifestFor(dependency, from); }
    catch { if (optional) continue; throw new Error(`Missing runtime dependency ${dependency} required by ${name}.`); }
    if (!supported(JSON.parse(await readFile(dependencyPath, "utf8")))) { if (optional) continue; throw new Error(`Unsupported runtime dependency ${dependency}.`); }
    await install(dependency, dependencyPath, destination);
  }
}

async function inventory(directory, prefix = "", files = {}) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name), name = join(prefix, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Runtime output must not contain symbolic links.");
    if (entry.isDirectory()) await inventory(path, name, files);
    else {
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(path)) hash.update(chunk);
      const stat = await lstat(path);
      files[name] = { sha256: hash.digest("hex"), bytes: stat.size, mode: stat.mode & 0o777 };
    }
  }
  return files;
}

try {
  await build({ absWorkingDir: root, entryPoints: { worker: "src/main.ts", "git-askpass": "src/credentials/askpass-entry.ts", gh: "src/credentials/gh-entry.ts" },
    outdir: staging, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", target: "node24", format: "esm", external,
    banner: { js: 'import { createRequire as createRuntimeRequire } from "node:module"; const require = createRuntimeRequire(import.meta.url);' },
    legalComments: "linked", sourcemap: false, logLevel: "warning",
  });
  for (const name of external) {
    const path = await manifestFor(name, request), manifest = JSON.parse(await readFile(path, "utf8"));
    pins[name] = manifest.version;
    if (name !== "node-pty" && manifest.version !== sourcePackage.dependencies[name]) throw new Error(`Runtime pin mismatch for ${name}.`);
    await install(name, path);
  }
  // These optional npm packages are mandatory on the target VM. Fail at build
  // time instead of downloading a native binary on an authenticated agent run.
  for (const name of [`@openai/codex-linux-${process.arch}`, `@anthropic-ai/claude-agent-sdk-linux-${process.arch}`, `@cursor/sdk-linux-${process.arch}`])
    if (!Object.values(packages).some(pkg => pkg.name === name)) throw new Error(`Missing platform runtime ${name}.`);
  await cp(join(root, "bin"), join(staging, "bin"), { recursive: true, dereference: true });
  await chmod(join(staging, "bin/gh"), 0o755); await chmod(join(staging, "bin/git-askpass"), 0o755);
  for (const name of ["LICENSE", "THIRD-PARTY-NOTICES.md", "THIRD-PARTY-LICENSES.txt"])
    await copyFile(join(repository, name), join(staging, name));
  await writeFile(join(staging, "package.json"), JSON.stringify({ name: sourcePackage.name, version: sourcePackage.version, private: true, type: "module", license: sourcePackage.license, engines: sourcePackage.engines }, null, 2) + "\n");
  await writeFile(join(staging, "runtime-manifest.json"), JSON.stringify({ version: 1, node: "24", platform: process.platform, arch: process.arch, pins, packages, files: await inventory(staging) }, null, 2) + "\n");
  await rm(output, { recursive: true, force: true }); await rename(staging, output);
  process.stdout.write(`Cloud worker built for ${process.platform}/${process.arch}; ${Object.keys(packages).length} runtime packages.\n`);
} catch (error) {
  await rm(staging, { recursive: true, force: true }); throw error;
}
