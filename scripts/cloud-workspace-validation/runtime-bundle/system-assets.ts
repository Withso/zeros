import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DependencyInventoryEntry } from "./closure";
import { canonicalJson, check, sha256 } from "./manifest";
import { runTool, type ToolOptions } from "./toolchain";
import { downloadRuntimeAsset, RuntimeAssetError, runtimeAssetLockIdentity } from "./asset-files.mjs";

export type RuntimeAssetPackage = {
  name: string;
  version: string;
  architecture: "amd64" | "all";
  component: string;
  filename: string;
  size: number;
  sha256: string;
  license: string;
  copyrightSha256: string;
  suite?: string;
  builtUsingField?: "Built-Using" | "Static-Built-Using";
  builtUsing?: string;
};
type PinnedFile = { path: string; sha256: string; size: number };
type AssetRelease = PinnedFile & { suite: string; codename: string; origin: string; date?: string; validUntil?: string | null };
type AssetLock = {
  schema: "zeros.runtime-system-assets-lock/v1";
  archive: string;
  mirror: string;
  release: AssetRelease;
  additionalReleases?: AssetRelease[];
  key: { file: string; sha256: string; fingerprint: string };
  indexes: PinnedFile[];
  packages: RuntimeAssetPackage[];
  sources: { name: string; version: string; component: string; suite?: string; directory: string; files: PinnedFile[] }[];
  gitLfsNotices?: { builtUsing: string; builtUsingField?: string };
};

const PACKAGE_NAMES = ["git-lfs", "fonts-noto-color-emoji", "fonts-unifont", "xfonts-cyrillic", "xfonts-scalable",
  "fonts-ipafont-gothic", "fonts-wqy-zenhei", "fonts-tlwg-loma-otf", "fonts-freefont-ttf"].sort();
// Canonical families of the pinned fonts exposed by fontconfig/FreeType. A
// matching face is excluded with all its localized aliases and styles too.
const BUNDLED_FONT_FAMILIES = [
  "Noto Color Emoji", "Unifont", "Unifont CSUR", "Unifont Sample", "Unifont Upper", "Unifont-JP",
  "IPAGothic", "IPAPGothic", "WenQuanYi Zen Hei", "WenQuanYi Zen Hei Mono", "WenQuanYi Zen Hei Sharp",
  "Loma", "FreeSans", "FreeSerif", "FreeMono", "Bitstream Charter", "Courier 10 Pitch",
];
const safePath = (name: string) => typeof name === "string" && /^[A-Za-z0-9_+./-]+$/.test(name) &&
  !path.posix.isAbsolute(name) && name.split("/").every(part => part !== "" && part !== "." && part !== "..");

function stanzas(source: string): Record<string, string>[] {
  return source.trim().split(/\n\n+/).map(block => {
    const fields: Record<string, string> = Object.create(null);
    let previous = "";
    for (const line of block.split("\n")) {
      if (/^[ \t]/.test(line) && previous) { fields[previous] += `\n${line.trim()}`; continue; }
      const match = /^([A-Za-z][A-Za-z0-9-]*):(?: (.*))?$/.exec(line);
      check(match && !Object.hasOwn(fields, match[1]), "asset_metadata");
      previous = match[1]; fields[previous] = match[2] ?? "";
    }
    return fields;
  });
}

export function authenticatePackageIndex(index: string, packages: RuntimeAssetPackage[]): void {
  const byName = new Map(packages.map(pin => [pin.name, pin]));
  const found = new Set<string>();
  for (const entry of stanzas(index)) {
    const pin = byName.get(entry.Package);
    if (!pin) continue;
    check(!found.has(pin.name) && safePath(pin.filename) && pin.filename.startsWith("pool/") &&
      entry.Version === pin.version && entry.Architecture === pin.architecture &&
      entry.Filename === pin.filename && entry.Size === String(pin.size) && entry.SHA256 === pin.sha256 &&
      (pin.builtUsingField === undefined && pin.builtUsing === undefined ||
        ["Built-Using", "Static-Built-Using"].includes(pin.builtUsingField!) &&
        typeof pin.builtUsing === "string" && entry[pin.builtUsingField!] === pin.builtUsing),
    "asset_package_pin");
    found.add(pin.name);
  }
  check(found.size === packages.length, "asset_package_pin");
}

/** No ambient keyring, trust database, key retrieval or APT hooks participate. */
export async function verifySignedRelease(options: {
  bytes: Buffer; key: Buffer; fingerprint: string; work: string; env: NodeJS.ProcessEnv;
}): Promise<string> {
  const home = path.join(options.work, "gnupg");
  await mkdir(home, { mode: 0o700 });
  const publicKey = path.join(home, "archive.asc"), keyring = path.join(home, "archive.gpg");
  const signed = path.join(home, "InRelease"), verified = path.join(home, "Release");
  await writeFile(publicKey, options.key, { flag: "wx", mode: 0o600 });
  await writeFile(signed, options.bytes, { flag: "wx", mode: 0o600 });
  const command = { cwd: home, env: { ...options.env, HOME: home, GNUPGHOME: home }, timeout: 30_000 };
  const args = ["--no-options", "--batch", "--no-autostart", "--homedir", home, "--no-default-keyring",
    "--no-auto-key-retrieve", "--no-auto-check-trustdb"];
  await runTool("gpg", [...args, "--output", keyring, "--dearmor", publicKey], command, "asset_signature");
  const status = await runTool("gpg", [...args, "--keyring", keyring, "--status-fd", "1", "--output", verified,
    "--decrypt", signed], command, "asset_signature");
  const signatures = [...status.matchAll(/^\[GNUPG:\] VALIDSIG (.+)$/gm)].map(match => match[1].split(" "));
  check(signatures.length === 1 && signatures[0][0] === options.fingerprint &&
    ["8", "9", "10", "11"].includes(signatures[0][7]) &&
    !/^\[GNUPG:\] (?:BADSIG|ERRSIG|REVKEYSIG|EXPKEYSIG|EXPSIG|NODATA)\b/m.test(status), "asset_signature");
  return readFile(verified, "utf8");
}

async function download(lock: AssetLock, pin: PinnedFile): Promise<Buffer> {
  try { return await downloadRuntimeAsset({ ...pin, url: new URL(pin.path, lock.archive).href }, { mirror: lock.mirror }); }
  catch (error) { check(false, error instanceof RuntimeAssetError ? error.check : "asset_download"); }
}

export async function extractRuntimeDeb(archive: string, destination: string, command: ToolOptions): Promise<void> {
  await runTool("python3", [fileURLToPath(new URL("./extract-deb.py", import.meta.url)), archive, destination], command, "asset_deb");
}

async function copyAsset(source: string, destination: string, executable = false): Promise<void> {
  const info = await lstat(source);
  check(info.isFile() && info.nlink === 1 && !(info.mode & 0o7022) && await realpath(source) === source,
    "asset_file");
  if (executable) check(Boolean(info.mode & 0o111), "asset_file");
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
  await copyFile(source, destination);
  await chmod(destination, executable ? 0o555 : 0o444);
}

export async function stageExtractedSystemAssets(options: {
  runtime: string; packages: RuntimeAssetPackage[]; extracted: Map<string, string>;
}): Promise<DependencyInventoryEntry[]> {
  check(JSON.stringify(options.packages.map(pin => pin.name).sort()) === JSON.stringify(PACKAGE_NAMES), "asset_package_set");
  const fonts: string[] = [], inventory: DependencyInventoryEntry[] = [];
  for (const pin of options.packages) {
    const root = options.extracted.get(pin.name);
    check(root, "asset_package_set");
    const copyright = path.join(root, `usr/share/doc/${pin.name}/copyright`);
    check(sha256(await readFile(copyright)) === pin.copyrightSha256, "asset_copyright");
    await copyAsset(copyright, path.join(options.runtime, `lib/runtime-system-assets/${pin.name}/copyright`));
    const destination = pin.name === "git-lfs" ? "bin/git-lfs" : `worker/design-fonts/${pin.name}`;
    if (pin.name === "git-lfs") await copyAsset(path.join(root, "usr/bin/git-lfs"), path.join(options.runtime, destination), true);
    else {
      const before = fonts.length;
      const visit = async (relative: string) => {
        const source = path.join(root, "usr/share/fonts", relative), info = await lstat(source);
        check(!info.isSymbolicLink(), "asset_file");
        if (info.isDirectory()) {
          for (const name of (await readdir(source)).sort()) await visit(path.posix.join(relative, name));
        } else if (/\.(?:ttf|ttc|otf|pfb|pfa|afm|pcf(?:\.gz)?|bdf(?:\.gz)?)$/i.test(relative)) {
          const target = `${destination}/${relative}`;
          await copyAsset(source, path.join(options.runtime, target));
          if (!relative.endsWith(".afm")) fonts.push(target);
        }
      };
      await visit("");
      check(fonts.length > before, "asset_fonts_missing");
    }
    inventory.push({ name: pin.name, version: pin.version, license: pin.license, path: destination });
  }
  const worker = path.join(options.runtime, "worker");
  // The selected system config already names the physical runtime. Derive its
  // executable without PATH or a facade; embedding the content-derived ID here
  // would make the archive's own hash recursive. Git expands %f safely itself.
  const lfs = ': "${GIT_CONFIG_SYSTEM:?Missing runtime Git configuration}"; exec "${GIT_CONFIG_SYSTEM%/worker/gitconfig}/bin/git-lfs"';
  const filters = Object.entries({ clean: `${lfs} clean -- %f`, smudge: `${lfs} smudge -- %f`, process: `${lfs} filter-process` })
    .map(([name, command]) => `\t${name} = ${JSON.stringify(command)}\n`).join("");
  await writeFile(path.join(worker, "gitconfig"), `[filter "lfs"]\n${filters}\trequired = true\n`, { mode: 0o444, flag: "wx" });
  // Fontconfig's glob filters apply to directories, separately from pattern
  // filters. Qualify family rejection at scan time instead: only stock copies
  // get this marker. A rule-specific cache salt prevents reuse of unmarked host
  // patterns (or a previous family set), without embedding a runtime/build path.
  const stockSalt = `zeros-runtime-stock-v1-${sha256(canonicalJson(BUNDLED_FONT_FAMILIES)).slice(0, 12)}`;
  const stockRules = BUNDLED_FONT_FAMILIES.map(family => `  <match target="scan">
    <test name="file" compare="contains"><string>/usr/share/fonts/</string></test>
    <test name="family"><string>${family}</string></test>
    <edit name="fontformat" mode="assign"><string>ZerosBlockedSystemFont</string></edit>
  </match>`).join("\n");
  await writeFile(path.join(worker, "design-fonts/fonts.conf"), `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <dir prefix="relative">.</dir>
  <dir salt="${stockSalt}">/usr/share/fonts</dir>
  <cachedir prefix="xdg">fontconfig</cachedir>
${stockRules}
  <selectfont><rejectfont><pattern>
    <patelt name="fontformat"><string>ZerosBlockedSystemFont</string></patelt>
  </pattern></rejectfont></selectfont>
  <alias><family>sans-serif</family><prefer><family>FreeSans</family></prefer></alias>
  <alias><family>serif</family><prefer><family>FreeSerif</family></prefer></alias>
  <alias><family>monospace</family><prefer><family>FreeMono</family></prefer></alias>
</fontconfig>
`, { mode: 0o444, flag: "wx" });
  await writeFile(path.join(worker, "runtime-system-assets.json"), canonicalJson({
    schema: "zeros.runtime-system-assets/v1", gitLfs: "bin/git-lfs", gitConfig: "worker/gitconfig",
    fontConfig: "worker/design-fonts/fonts.conf", fonts: fonts.sort(), packages: options.packages,
  }), { mode: 0o444, flag: "wx" });
  return inventory;
}

/** Acquire on the build host; never install packages or run maintainer scripts. */
export async function stageRuntimeSystemAssets(options: {
  checkout: string; runtime: string; work: string; env: NodeJS.ProcessEnv;
}): Promise<DependencyInventoryEntry[]> {
  const assets = path.join(options.checkout, "third_party/runtime-assets");
  const lock = JSON.parse(await readFile(path.join(assets, "lock.json"), "utf8")) as AssetLock;
  check(lock.schema === "zeros.runtime-system-assets-lock/v1" && lock.archive === "https://archive.ubuntu.com/ubuntu/" &&
    lock.packages.every(pin => ["amd64", "all"].includes(pin.architecture)), "asset_lock");
  check(lock.mirror === runtimeAssetLockIdentity(lock).mirror, "asset_mirror_lock");
  check(lock.additionalReleases === undefined || Array.isArray(lock.additionalReleases), "asset_release");
  const releases = [lock.release, ...(lock.additionalReleases ?? [])];
  check(releases.length <= 4 && releases.every(release => /^[a-z0-9][a-z0-9-]*$/.test(release.suite) &&
    release.path === `dists/${release.suite}/InRelease`) && new Set(releases.map(release => release.suite)).size === releases.length, "asset_release");
  const suite = (pin: { suite?: string }) => {
    const selected = pin.suite ?? lock.release.suite;
    check(releases.some(release => release.suite === selected), "asset_release");
    return selected;
  };
  const indexes = [...new Set([
    ...lock.packages.map(pin => `dists/${suite(pin)}/${pin.component}/binary-amd64/Packages.xz`),
    ...lock.sources.map(pin => `dists/${suite(pin)}/${pin.component}/source/Sources.xz`),
  ])].sort();
  check(JSON.stringify(lock.indexes.map(index => index.path).sort()) === JSON.stringify(indexes), "asset_index_set");
  const lfs = lock.packages.find(pin => pin.name === "git-lfs");
  if (lfs?.builtUsingField) check(lock.gitLfsNotices?.builtUsing === lfs.builtUsing &&
    lock.gitLfsNotices?.builtUsingField === lfs.builtUsingField, "asset_package_pin");
  const work = path.join(options.work, "system-assets"); await mkdir(work, { mode: 0o700 });
  const command = { cwd: work, env: options.env };
  const get = async (pin: PinnedFile) => {
    check(safePath(pin.path) && /^[a-f0-9]{64}$/.test(pin.sha256) && Number.isSafeInteger(pin.size) && pin.size > 0 && pin.size <= 128 * 1024 * 1024, "asset_lock");
    return download(lock, pin);
  };
  check(safePath(lock.key.file), "asset_lock");
  const key = await readFile(path.join(assets, lock.key.file));
  check(sha256(key) === lock.key.sha256, "asset_key_pin");
  const metadata = new Map<string, { signed: Buffer; hashes: Map<string, { digest: string; size: string }> }>();
  for (const pin of releases) {
    const signed = await get(pin), signatureWork = path.join(work, "metadata", pin.suite);
    await mkdir(signatureWork, { recursive: true, mode: 0o700 });
    const release = stanzas(await verifySignedRelease({ bytes: signed, key, fingerprint: lock.key.fingerprint,
      work: signatureWork, env: options.env }))[0];
    check(release.Origin === pin.origin && release.Suite === pin.suite && release.Codename === pin.codename &&
      (pin.date === undefined || release.Date === pin.date) &&
      (pin.validUntil === undefined || (release["Valid-Until"] ?? null) === pin.validUntil), "asset_release");
    const hashes = new Map(release.SHA256.trim().split("\n").map(line => {
      const [digest, size, name] = line.trim().split(/\s+/); return [name, { digest, size }];
    }));
    metadata.set(pin.suite, { signed, hashes });
  }
  for (const index of lock.indexes) {
    const selected = index.path.split("/")[1], relative = index.path.split("/").slice(2).join("/");
    const expected = metadata.get(selected)?.hashes.get(relative);
    check(expected?.digest === index.sha256 && expected?.size === String(index.size), "asset_index_pin");
    const compressed = path.join(work, index.path.replaceAll("/", "-"));
    await writeFile(compressed, await get(index), { flag: "wx", mode: 0o600 });
    await runTool("xz", ["--decompress", "--keep", compressed], command, "asset_index");
    const text = await readFile(compressed.slice(0, -3), "utf8"), component = relative.split("/")[0];
    if (relative.endsWith("/Packages.xz")) authenticatePackageIndex(text, lock.packages.filter(pin => pin.component === component && suite(pin) === selected));
    else {
      const sources = stanzas(text);
      for (const pin of lock.sources.filter(pin => pin.component === component && suite(pin) === selected)) {
        const found = sources.filter(source => source.Package === pin.name && source.Version === pin.version);
        check(found.length === 1 && found[0].Directory === pin.directory, "asset_source_pin");
        const hashes = found[0]["Checksums-Sha256"].split("\n").map(line => line.trim().split(/\s+/));
        check(hashes.filter(row => row.length === 3).length === pin.files.length && pin.files.every(file =>
          hashes.some(([digest, size, name]) => digest === file.sha256 && size === String(file.size) && `${pin.directory}/${name}` === file.path)), "asset_source_pin");
      }
    }
  }
  const extracted = new Map<string, string>();
  for (const pin of lock.packages) {
    const deb = path.join(work, `${pin.name}.deb`), root = path.join(work, pin.name);
    await writeFile(deb, await get({ path: pin.filename, size: pin.size, sha256: pin.sha256 }), { flag: "wx", mode: 0o600 });
    await extractRuntimeDeb(deb, root, command); extracted.set(pin.name, root);
  }
  const inventory = await stageExtractedSystemAssets({ runtime: options.runtime, packages: lock.packages, extracted });
  const provenance = path.join(options.runtime, "worker/third_party/runtime-assets");
  for (const [suite, { signed }] of metadata)
    await writeFile(path.join(provenance, suite === lock.release.suite ? "InRelease" : `InRelease.${suite}`), signed, { flag: "wx", mode: 0o444 });
  // GPL/MPL sources accompany redistribution, including Debian build recipes.
  for (const source of lock.sources) for (const file of source.files) {
    const target = path.join(provenance, "sources", source.name, path.basename(file.path));
    await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
    const bytes = await get(file);
    // Small retained sources can already have arrived with the notice payload.
    // Create exclusively; otherwise reuse only an ordinary, immutable copy of
    // the same authenticated bytes, checked and read through one descriptor.
    try { await writeFile(target, bytes, { flag: "wx", mode: 0o444 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      check(await realpath(target) === target, "asset_source_copy");
      const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const existing = await handle.stat();
        check(existing.isFile() && existing.nlink === 1 && (existing.mode & 0o7777) === 0o444 &&
          existing.size === file.size && sha256(await handle.readFile()) === file.sha256, "asset_source_copy");
      } finally { await handle.close(); }
    }
  }
  return inventory;
}
