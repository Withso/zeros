import { execFile } from "node:child_process";
import { mkdir, open, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  BundleError,
  check,
  NODE_MODULES_ABI,
  NODE_VERSION,
  PNPM_VERSION,
  sha256,
  type ManifestEntry,
} from "./manifest";

const execute = promisify(execFile);
export type ToolOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeout?: number;
};
export async function runTool(
  command: string,
  args: string[],
  options: ToolOptions,
  failure: string,
): Promise<string> {
  try {
    const result = await execute(command, args, {
      ...options,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: options.timeout ?? 15 * 60_000,
    });
    return result.stdout.trim();
  } catch (error) {
    const result = error as {
      code?: number;
      killed?: boolean;
      stdout?: string;
      stderr?: string;
    };
    // Child output is intentionally never forwarded to CLI/CI diagnostics. The
    // environment has no credentials, but tools can still print host paths.
    throw Object.assign(new BundleError(failure), {
      exitCode: typeof result.code === "number" ? result.code : null,
      timedOut: result.killed === true,
      toolStdout: result.stdout,
      toolOutput: result.stderr || result.stdout,
    });
  }
}

export function buildEnvironment(work: string): NodeJS.ProcessEnv {
  // Deliberate allowlist: no provider, GitHub, npm auth or inherited Node flags
  // are passed to install scripts, compilers, browser installers or probes.
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: path.join(work, "home"),
    TMPDIR: path.join(work, "tmp"),
    CI: "true",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
    SOURCE_DATE_EPOCH: "0",
    ELECTRON_SKIP_BINARY_DOWNLOAD: "1",
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
    ZEROS_CLOUD_WORKSPACES_ENABLED: "true",
    npm_config_registry: "https://registry.npmjs.org",
    npm_config_update_notifier: "false",
    npm_config_cache: path.join(work, "npm-cache"),
    CFLAGS: `-ffile-prefix-map=${work}=. -fdebug-prefix-map=${work}=.`,
    CXXFLAGS: `-ffile-prefix-map=${work}=. -fdebug-prefix-map=${work}=.`,
    PYTHON: "/usr/bin/python3",
  };
}

async function download(url: string, limit: number): Promise<Buffer> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(120_000),
    redirect: "error",
  });
  check(response.ok && response.body, "toolchain_download");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    check(size <= limit, "toolchain_download");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function prepareToolchain(
  work: string,
  env: NodeJS.ProcessEnv,
): Promise<{
  node: string;
  nodeDirectory: string;
  pnpm: string;
  nodeArchiveSha256: string;
  nodeArchiveUrl: string;
  versions: Record<string, string | number>;
}> {
  await mkdir(env.HOME!, { recursive: true, mode: 0o700 });
  await mkdir(env.TMPDIR!, { recursive: true, mode: 0o700 });
  const tools = path.join(work, "tools");
  await mkdir(tools);
  const name = `node-v${NODE_VERSION}-linux-x64.tar.xz`;
  const base = `https://nodejs.org/dist/v${NODE_VERSION}/`;
  const checksums = (
    await download(`${base}SHASUMS256.txt`, 1024 * 1024)
  ).toString("utf8");
  const lines = checksums
    .split("\n")
    .filter((line) => line.endsWith(`  ${name}`));
  check(
    lines.length === 1 && /^[a-f0-9]{64}  /.test(lines[0]),
    "node_checksum",
  );
  const archive = await download(base + name, 128 * 1024 * 1024);
  const nodeArchiveSha256 = sha256(archive);
  // Keep downloaded bytes in memory until the pinned Node distribution's
  // official HTTPS SHASUMS256 entry authenticates them; only then persist them.
  check(nodeArchiveSha256 === lines[0].slice(0, 64), "node_checksum");
  await writeFile(path.join(tools, name), archive, { flag: "wx", mode: 0o600 });
  await runTool(
    "tar",
    ["-xJf", path.join(tools, name), "-C", tools, "--no-same-owner"],
    { cwd: work, env },
    "node_extract",
  );
  const nodeDirectory = path.join(tools, `node-v${NODE_VERSION}-linux-x64`);
  const node = path.join(nodeDirectory, "bin/node");
  const pnpmDirectory = path.join(tools, "pnpm");
  env.PATH = `${path.join(nodeDirectory, "bin")}:${path.join(pnpmDirectory, "bin")}:${env.PATH}`;
  const measured = JSON.parse(
    await runTool(
      node,
      [
        "-p",
        "JSON.stringify({node:process.versions.node,abi:Number(process.versions.modules)})",
      ],
      { cwd: work, env },
      "node_abi",
    ),
  );
  check(
    measured.node === NODE_VERSION && measured.abi === NODE_MODULES_ABI,
    "node_abi",
  );
  await runTool(
    node,
    [
      path.join(nodeDirectory, "lib/node_modules/npm/bin/npm-cli.js"),
      "install",
      "--global",
      "--prefix",
      pnpmDirectory,
      `pnpm@${PNPM_VERSION}`,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ],
    { cwd: work, env },
    "pnpm_install",
  );
  const pnpm = path.join(pnpmDirectory, "bin/pnpm");
  check(
    (await runTool(pnpm, ["--version"], { cwd: work, env }, "pnpm_version")) ===
      PNPM_VERSION,
    "pnpm_version",
  );
  const versions: Record<string, string | number> = {
    node: measured.node,
    nodeModulesAbi: measured.abi,
    pnpm: PNPM_VERSION,
    builderNode: process.versions.node,
    builderZlib: process.versions.zlib,
  };
  for (const command of ["cc", "c++", "readelf", "tar", "python3"]) {
    versions[command] = (
      await runTool(
        command,
        ["--version"],
        { cwd: work, env },
        "host_toolchain",
      )
    ).split("\n")[0];
  }
  versions.glibc = await runTool(
    "getconf",
    ["GNU_LIBC_VERSION"],
    { cwd: work, env },
    "host_toolchain",
  );
  return {
    node,
    nodeDirectory,
    pnpm,
    nodeArchiveSha256,
    nodeArchiveUrl: base + name,
    versions,
  };
}

export function versionAtMost(actual: string, maximum: string): boolean {
  const a = actual.split(".").map(Number),
    b = maximum.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    if ((a[index] ?? 0) !== (b[index] ?? 0))
      return (a[index] ?? 0) < (b[index] ?? 0);
  }
  return true;
}
export function elfVersionNeeds(output: string): {
  glibc: string[];
  glibcxx: string[];
  cxxabi: string[];
} {
  // Version definitions do not impose requirements; inspect only .gnu.version_r.
  const needs = output
    .split(/Version needs section/)
    .slice(1)
    .join("\n");
  function names(prefix: string) {
    return [
      ...new Set(
        [
          ...needs.matchAll(
            new RegExp(`Name: ${prefix}_([0-9]+(?:\\.[0-9]+)+)`, "g"),
          ),
        ].map((match) => match[1]),
      ),
    ].sort((a, b) => (versionAtMost(a, b) ? -1 : 1));
  }
  return {
    glibc: names("GLIBC"),
    glibcxx: names("GLIBCXX"),
    cxxabi: names("CXXABI"),
  };
}
export type NativeRequirement = {
  path: string;
  machine: "x86_64";
  glibc: string[];
  glibcxx: string[];
  cxxabi: string[];
  libraries: string[];
};
export async function inspectNativeRequirements(
  root: string,
  entries: ManifestEntry[],
  env: NodeJS.ProcessEnv,
): Promise<NativeRequirement[]> {
  const result: NativeRequirement[] = [];
  for (const entry of entries) {
    if (entry.type !== "file") continue;
    const filename = path.join(root, entry.path);
    const file = await open(filename, "r");
    let header: Buffer;
    try {
      const read = await file.read(Buffer.alloc(32), 0, 32, 0);
      header = read.buffer.subarray(0, read.bytesRead);
    } finally {
      await file.close();
    }
    const magic = header.subarray(0, 4).toString("hex");
    const foreign =
      ["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe"].includes(
        magic,
      ) || header.subarray(0, 2).toString() === "MZ";
    if (foreign)
      throw Object.assign(new BundleError("native_platform"), {
        entry: entry.path,
      });
    if (magic !== "7f454c46") {
      check(!entry.path.endsWith(".node"), "native_platform");
      continue;
    }
    check(
      header[4] === 2 && header[5] === 1 && header.readUInt16LE(18) === 62,
      "native_platform",
    );
    const options = { cwd: root, env, timeout: 30_000 };
    const versions = elfVersionNeeds(
      await runTool(
        "readelf",
        ["--version-info", "--wide", filename],
        options,
        "elf_inspection",
      ),
    );
    if (!versions.glibc.every((version) => versionAtMost(version, "2.39")))
      throw Object.assign(new BundleError("glibc_compatibility"), {
        entry: entry.path,
      });
    const dynamic = await runTool(
      "readelf",
      ["--dynamic", "--wide", filename],
      options,
      "elf_inspection",
    );
    const libraries = [
      ...dynamic.matchAll(/\(NEEDED\).*Shared library: \[([^\]]+)\]/g),
    ]
      .map((match) => match[1])
      .sort();
    check(
      libraries.every((name) => !name.includes("/")),
      "elf_library_path",
    );
    result.push({
      path: entry.path,
      machine: "x86_64",
      ...versions,
      libraries,
    });
  }
  check(
    result.some((entry) => entry.path === "bin/node"),
    "native_inventory",
  );
  return result;
}
