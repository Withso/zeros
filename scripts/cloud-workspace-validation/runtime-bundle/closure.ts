import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import {
  BundleError,
  byteOrder,
  check,
  canonicalJson,
  validPath,
} from "./manifest";

const SANDBOX = "scripts/cloud-workspace-validation/sandbox";
// The sole runtime helper inventory. Required entries track the legacy image
// kit; later runtime PRs append future helpers here.
export const RUNTIME_HELPERS = [
  ...[
    "runtime-layout.json",
    "cgroup-resources.mjs",
    "cloud-resource-admission.mjs",
    "image-build-contract.mjs",
    "cloud-runtime-profile.mjs",
    "cloud-engine-cgroup.mjs",
    "cloud-setup-process.mjs",
    "cloud-computer-checkout.mjs",
    "cloud-engine-view.mjs",
    "cloud-engine-launcher.mjs",
    "write-image-build-metadata.mjs",
    "attest-cloud-worker.mjs",
    "consume-cloud-admission.mjs",
    "install-cloud-preview-links.mjs",
    "install-cloud-github-credential.mjs",
    "cloud-github-refresh-request.mjs",
    "cloud-git-askpass.mjs",
    "cloud-worker-supervisor.mjs",
    "ensure-cloud-worker-supervisor.mjs",
    "setup-cloud-workspace.mjs",
    "zeros-cloud-engine.apparmor",
  ].map((name) => ({
    source: `${SANDBOX}/${name}`,
    target: `lib/zeros/${name}`,
    optional: false,
  })),
  {
    source: "apps/desktop/src/engine/agents/containment/cloud-runtime-root.mjs",
    target: "lib/zeros/cloud-runtime-root.mjs",
    optional: false,
  },
  {
    source: `${SANDBOX}/runtime-self-test.mjs`,
    target: "lib/zeros/runtime-self-test.mjs",
    optional: true,
  },
];
export const SOURCE_SLICES = [
  // Workspace packages (protocol/design-core/design-web) are copied in full by
  // the dependency walk, which also restores their own node_modules links.
  "apps/desktop/src",
  "catalogs",
  `${SANDBOX}`,
  "scripts/cloud-workspace-validation/lib",
  "scripts/zsr-qualification",
  "third_party",
];
export const ROOT_METADATA = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "LICENSE",
  "THIRD-PARTY-NOTICES.md",
  "THIRD-PARTY-LICENSES.txt",
];
export const HARNESS_ROOTS = ["tsx", "typescript"];

export function forbiddenPayloadPath(relative: string): boolean {
  return relative
    .split("/")
    .some(
      (part) =>
        part.startsWith(".env") ||
        [
          ".git",
          ".context",
          ".cache",
          "__pycache__",
          ".pnpm-store",
          ".npmrc",
          ".netrc",
          ".ssh",
          ".aws",
          ".codex-protocol-cache",
        ].includes(part),
    );
}
export function within(root: string, filename: string): boolean {
  const relative = path.relative(root, filename);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}
async function exists(filename: string): Promise<boolean> {
  try {
    await lstat(filename);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Copy, never dereference or hardlink. Links are installed after ordinary files
 * and validated against the complete manifest before the artifact is written. */
export async function copyPayload(
  source: string,
  destination: string,
  omit: (relative: string) => boolean = () => false,
): Promise<void> {
  const links: { filename: string; target: string }[] = [];
  async function visit(relative: string): Promise<void> {
    if (relative && (forbiddenPayloadPath(relative) || omit(relative))) return;
    const input = path.join(source, relative),
      output = path.join(destination, relative);
    const info = await lstat(input);
    if (info.isSymbolicLink()) {
      await mkdir(path.dirname(output), { recursive: true, mode: 0o755 });
      links.push({ filename: output, target: await readlink(input) });
    } else if (info.isDirectory()) {
      await mkdir(output, { recursive: true, mode: 0o755 });
      await chmod(output, 0o755);
      for (const name of (await readdir(input)).sort(byteOrder))
        await visit(relative ? `${relative}/${name}` : name);
    } else {
      check(info.isFile(), "archive_member_type");
      await mkdir(path.dirname(output), { recursive: true, mode: 0o755 });
      await copyFile(input, output);
      await chmod(output, info.mode & 0o111 ? 0o555 : 0o444);
    }
  }
  await visit("");
  for (const link of links) await symlink(link.target, link.filename);
}

type Package = {
  name: string;
  version: string;
  license?: string;
  bin?: string | Record<string, string>;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  os?: string[];
  cpu?: string[];
};
export type DependencyInventoryEntry = {
  name: string;
  version: string;
  path: string;
  license: string | null;
};
async function packageJson(directory: string): Promise<Package> {
  return JSON.parse(
    await readFile(path.join(directory, "package.json"), "utf8"),
  ) as Package;
}
function platformAllows(rule: string[] | undefined, value: string): boolean {
  return (
    !rule ||
    (!rule.includes(`!${value}`) &&
      (rule.every((item) => item.startsWith("!")) || rule.includes(value)))
  );
}

function omitPackageFile(name: string, relative: string): boolean {
  if (relative === "node_modules") return true; // Dependency edges are copied separately.
  // Published non-runtime examples contain credential-shaped tokens or private
  // test keys. Preserve package code and all LICENSE/NOTICE files unchanged.
  if (name === "@octokit/auth-token" && relative === "README.md") return true;
  if (name === "ssh2" && relative === "test") return true;
  if (name === "zod" && relative === "src/v4/mini/tests") return true;
  if (name === "better-sqlite3" || name === "node-pty") {
    if (relative === "prebuilds") return true; // Rebuilt under the pinned Node below.
    if (relative.startsWith("build/")) {
      if (relative === "build/Release") return false;
      return !/^build\/Release\/(?:better_sqlite3\.node|test_extension\.node|pty\.node|spawn-helper)$/.test(
        relative,
      );
    }
  }
  if (
    name === "node-pty" &&
    relative.startsWith("third_party/conpty/") &&
    /\.(?:dll|exe)$/i.test(relative)
  )
    return true;
  // PuTTY Pageant bridge; ssh2's Linux agent transport uses Unix sockets.
  if (name === "ssh2" && relative === "util/pagent.exe") return true;
  // SRT's npm package embeds helpers for other targets; keep Linux x64 plus
  // shared source, Java assets and all notices. No unrelated dependency trimming.
  if (
    name === "@anthropic-ai/sandbox-runtime" &&
    (relative === "vendor/seccomp/arm64" || relative === "vendor/srt-win")
  )
    return true;
  return false;
}

export async function stageDependencyClosure(
  source: string,
  runtime: string,
  options: { harnessRoots?: string[] } = {},
): Promise<DependencyInventoryEntry[]> {
  source = await realpath(source);
  const worker = path.join(runtime, "worker");
  await mkdir(worker, { recursive: true, mode: 0o755 });
  const root = await packageJson(source);
  const visited = new Map<string, Package>();
  const links = new Map<string, string>();
  const bins = new Map<string, Map<string, string>>();

  async function resolvePackage(
    name: string,
    owner: string,
    optional: boolean,
  ): Promise<string | undefined> {
    check(/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name), "dependency_name");
    const require = createRequire(path.join(owner, "package.json"));
    // Asking for "buffer"/"events" alone returns null (Node built-ins), even
    // when the dependency graph declares their separate npm implementations.
    for (const nodeModules of require.resolve.paths(`${name}/package.json`) ??
      []) {
      const candidate = path.join(nodeModules, name);
      if (!(await exists(path.join(candidate, "package.json")))) continue;
      const physical = await realpath(candidate);
      check(
        within(source, candidate) && within(source, physical),
        "dependency_external",
      );
      if (candidate !== physical) links.set(candidate, physical);
      return physical;
    }
    check(optional, "dependency_missing");
    return undefined;
  }
  async function addBins(
    owner: string,
    physical: string,
    pkg: Package,
  ): Promise<void> {
    const directory = path.join(
      worker,
      path.relative(source, owner),
      "node_modules/.bin",
    );
    const entries = bins.get(directory) ?? new Map<string, string>();
    bins.set(directory, entries);
    const commands =
      typeof pkg.bin === "string"
        ? { [pkg.name.split("/").at(-1)!]: pkg.bin }
        : (pkg.bin ?? {});
    for (const [name, target] of Object.entries(commands)) {
      check(
        /^[a-zA-Z0-9_.-]+$/.test(name) && name !== "." && name !== "..",
        "bin_path",
      );
      const absolute = path.resolve(physical, target);
      check(within(physical, absolute) && (await exists(absolute)), "bin_path");
      const destination = path.join(worker, path.relative(source, absolute));
      check(
        !entries.has(name) || entries.get(name) === destination,
        "bin_collision",
      );
      entries.set(name, destination);
    }
  }
  async function edge(
    name: string,
    owner: string,
    optional: boolean,
  ): Promise<void> {
    const physical = await resolvePackage(name, owner, optional);
    if (!physical) return;
    const pkg = visited.get(physical) ?? (await packageJson(physical));
    check(
      platformAllows(pkg.os, "linux") && platformAllows(pkg.cpu, "x64"),
      "native_platform",
    );
    await addBins(owner, physical, pkg);
    if (visited.has(physical)) return;
    visited.set(physical, pkg);
    const dependencies = new Map<string, boolean>();
    for (const name of Object.keys(pkg.peerDependencies ?? {}))
      dependencies.set(
        name,
        pkg.peerDependenciesMeta?.[name]?.optional === true,
      );
    for (const name of Object.keys(pkg.dependencies ?? {}))
      dependencies.set(name, false);
    for (const name of Object.keys(pkg.optionalDependencies ?? {}))
      dependencies.set(name, true);
    for (const [name, optional] of [...dependencies].sort(([a], [b]) =>
      byteOrder(a, b),
    ))
      await edge(name, physical, optional);
  }
  const roots = new Map<string, boolean>();
  for (const name of Object.keys(root.dependencies ?? {}))
    roots.set(name, false);
  for (const name of options.harnessRoots ?? HARNESS_ROOTS)
    roots.set(name, false);
  for (const name of Object.keys(root.optionalDependencies ?? {}))
    roots.set(name, true);
  for (const [name, optional] of [...roots].sort(([a], [b]) => byteOrder(a, b)))
    await edge(name, source, optional);

  for (const [physical, pkg] of [...visited].sort(([a], [b]) =>
    byteOrder(a, b),
  )) {
    const destination = path.join(worker, path.relative(source, physical));
    await copyPayload(physical, destination, (relative) =>
      omitPackageFile(pkg.name, relative),
    );
    // better-sqlite3's platform export and default resolver prefer prebuilds.
    // Populate that slot with our source build, never its upstream prebuild.
    if (pkg.name === "better-sqlite3") {
      await copyPayload(
        path.join(physical, "build/Release/better_sqlite3.node"),
        path.join(destination, "prebuilds/linux-x64.node"),
      );
    }
  }
  for (const [from, target] of [...links].sort(([a], [b]) => byteOrder(a, b))) {
    const destination = path.join(worker, path.relative(source, from));
    const destinationTarget = path.join(worker, path.relative(source, target));
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
    await symlink(
      path.relative(path.dirname(destination), destinationTarget),
      destination,
    );
  }
  for (const [directory, entries] of bins) {
    if (!entries.size) continue;
    await mkdir(directory, { recursive: true, mode: 0o755 });
    for (const [name, target] of [...entries].sort(([a], [b]) =>
      byteOrder(a, b),
    )) {
      check(
        within(await realpath(runtime), await realpath(target)),
        "symlink_escape",
      );
      const file = await open(target, "r");
      let prefix: string;
      try {
        const { buffer, bytesRead } = await file.read(
          Buffer.alloc(256),
          0,
          256,
          0,
        );
        prefix = buffer.subarray(0, bytesRead).toString();
      } finally {
        await file.close();
      }
      const script =
        /^#![^\n]*\bnode(?:\s|$)/.test(prefix) || /\.[cm]?js$/.test(target);
      const relative = path.relative(directory, target);
      const node = path.relative(directory, path.join(runtime, "bin/node"));
      check(!/["`$\n\r]/.test(relative + node), "bin_path");
      const command = script
        ? `"$basedir/${node}" "$basedir/${relative}"`
        : `"$basedir/${relative}"`;
      await chmod(target, 0o555);
      await writeFile(
        path.join(directory, name),
        `#!/bin/sh\nbasedir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec ${command} "$@"\n`,
        { mode: 0o555, flag: "wx" },
      );
    }
  }
  return [...visited]
    .map(([physical, pkg]) => ({
      name: pkg.name,
      version: pkg.version,
      path: `worker/${path.relative(source, physical)}`,
      license: typeof pkg.license === "string" ? pkg.license : null,
    }))
    .sort((a, b) => byteOrder(a.path, b.path));
}

export async function stageSources(
  source: string,
  runtime: string,
): Promise<void> {
  const worker = path.join(runtime, "worker");
  for (const relative of SOURCE_SLICES) {
    await copyPayload(
      path.join(source, relative),
      path.join(worker, relative),
      (name) => name.split("/").includes("node_modules"),
    );
  }
  const metadata = [
    ...ROOT_METADATA,
    ...(await readdir(source)).filter((name) =>
      /^tsconfig.*\.json$/.test(name),
    ),
  ];
  for (const relative of metadata)
    await copyPayload(path.join(source, relative), path.join(worker, relative));
  for (const helper of RUNTIME_HELPERS) {
    const input = path.join(source, helper.source);
    if (helper.optional && !(await exists(input))) continue;
    await copyPayload(input, path.join(runtime, helper.target));
    await chmod(
      path.join(runtime, helper.target),
      helper.target.endsWith(".mjs") ? 0o555 : 0o444,
    );
  }
  await copyPayload(
    path.join(source, SANDBOX, "start-engine.sh"),
    path.join(runtime, "bin/start-engine.sh"),
  );
  await chmod(path.join(runtime, "bin/start-engine.sh"), 0o555);
}

// High-confidence shapes, not a generic entropy detector (digests, minified
// code and license text legitimately contain long hex/base64). Low-entropy
// placeholders match the repository secret gate's fixture policy.
const SECRET_SHAPE =
  /\b(?:gh[po]_[A-Za-z0-9]{36,}|ghs_\d+_[A-Za-z0-9._-]{40,}|ghs_[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]{8,})+|gh[sur]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,}|condw_[A-Za-z0-9_-]{20,}|sk-(?:proj-|svcacct-|ant-(?:api\d\d-)?)[A-Za-z0-9_-]{40,}|sk-(?!proj-|svcacct-|ant-)[A-Za-z0-9]{40,}|sk_(?:(?:test|live)_)?[A-Za-z0-9_-]{32,}|npm_[A-Za-z0-9]{36,}|AKIA[0-9A-Z]{16}|Bearer [A-Za-z0-9_.-]{32,}|eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{16,})/g;
function secretShaped(text: string): boolean {
  for (const match of text.matchAll(SECRET_SHAPE)) {
    const body = match[0].replace(
      /^(?:gh[pousr]_|github_pat_|condw_|sk-(?:ant-|proj-)?|sk_(?:(?:test|live)_)?|npm_|AKIA|Bearer )/,
      "",
    );
    if (new Set(body.replace(/[^A-Za-z0-9]/g, "")).size > 2) return true;
  }
  return /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/=\r\n]{80,}-----END /.test(
    text,
  );
}

export class PayloadScanError extends BundleError {
  readonly entry: string | undefined;

  constructor(check: string, relative: string) {
    super(check);
    // Diagnostics may include the relative payload name, never matched bytes,
    // symlink targets, host paths or credential-shaped filenames.
    this.entry =
      validPath(relative) && !secretShaped(relative) ? relative : undefined;
  }
}

export async function scanPayload(
  root: string,
  forbiddenPaths: string[],
): Promise<void> {
  const patterns = forbiddenPaths
    .filter(Boolean)
    .map((value) => Buffer.from(value));
  const overlap = Math.max(4096, ...patterns.map((value) => value.length));
  async function walk(relative: string): Promise<void> {
    const filename = path.join(root, relative);
    if (relative && (!validPath(relative) || forbiddenPayloadPath(relative)))
      throw new PayloadScanError("forbidden_payload", relative);
    const info = await lstat(filename);
    if (info.isSymbolicLink()) {
      const target = await readlink(filename);
      if (patterns.some((pattern) => target.includes(pattern.toString())))
        throw new PayloadScanError("build_path", relative);
    } else if (info.isDirectory()) {
      for (const name of await readdir(filename))
        await walk(relative ? `${relative}/${name}` : name);
    } else {
      if (!info.isFile())
        throw new PayloadScanError("archive_member_type", relative);
      let carry = Buffer.alloc(0);
      for await (const chunk of createReadStream(filename, {
        highWaterMark: 64 * 1024,
      })) {
        const bytes = Buffer.concat([carry, chunk as Buffer]);
        const failure = patterns.some((pattern) => bytes.includes(pattern))
          ? "build_path"
          : secretShaped(bytes.toString("latin1"))
            ? "secret_shape"
            : null;
        if (failure) throw new PayloadScanError(failure, relative);
        carry = bytes.subarray(Math.max(0, bytes.length - overlap));
      }
    }
  }
  await walk("");
}

export async function writeDependencyInventory(
  runtime: string,
  packages: DependencyInventoryEntry[],
): Promise<void> {
  await writeFile(
    path.join(runtime, "worker/runtime-dependencies.json"),
    canonicalJson({ schema: "zeros.runtime-dependencies/v1", packages }),
    { mode: 0o444, flag: "wx" },
  );
}
