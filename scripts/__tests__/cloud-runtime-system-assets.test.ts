import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authenticatePackageIndex,
  extractRuntimeDeb,
  stageExtractedSystemAssets,
  stageRuntimeSystemAssets,
  verifySignedRelease,
  type RuntimeAssetPackage,
} from "../cloud-workspace-validation/runtime-bundle/system-assets";
import { canonicalJson, createManifest, inventoryTree, sha256, sha256File } from "../cloud-workspace-validation/runtime-bundle/manifest";
import { writeRuntimeArchive } from "../cloud-workspace-validation/runtime-bundle/archive";
import { inspectNativeRequirements, runTool } from "../cloud-workspace-validation/runtime-bundle/toolchain";

const temporary: string[] = [];
async function directory() {
  const value = await mkdtemp(path.join(os.tmpdir(), "zeros-assets-"));
  temporary.push(value);
  return value;
}
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const pin: RuntimeAssetPackage = {
  name: "git-lfs", version: "1.2.3-1", architecture: "amd64", component: "universe",
  filename: "pool/universe/g/git-lfs/git-lfs_1.2.3-1_amd64.deb", size: 123, sha256: "a".repeat(64),
  license: "MIT", copyrightSha256: sha256("fixture terms"),
};
const stanza = (overrides: Record<string, string> = {}) => Object.entries({
  Package: pin.name, Version: pin.version, Architecture: pin.architecture,
  Filename: pin.filename, Size: String(pin.size), SHA256: pin.sha256, ...overrides,
}).map(([key, value]) => `${key}: ${value}`).join("\n");

describe("authenticated runtime package selection", () => {
  it("requires the exact archive version, architecture, length and digest", () => {
    expect(() => authenticatePackageIndex(stanza(), [pin])).not.toThrow();
    for (const difference of [{ Version: "9.0" }, { Architecture: "arm64" }, { SHA256: "b".repeat(64) },
      { Size: "124" }, { Filename: "pool/universe/g/other.deb" }])
      expect(() => authenticatePackageIndex(stanza(difference), [pin])).toThrow(/asset_package_pin/);
  });
  it("rejects missing, duplicate and escaped package entries", () => {
    expect(() => authenticatePackageIndex(stanza({ Package: "unrelated" }), [pin])).toThrow();
    expect(() => authenticatePackageIndex(`${stanza()}\n\n${stanza()}`, [pin])).toThrow();
    const escaped = { ...pin, filename: "pool/../../outside.deb" };
    expect(() => authenticatePackageIndex(stanza({ Filename: escaped.filename }), [escaped])).toThrow();
    expect(() => authenticatePackageIndex(`${stanza()}\nSHA256: ${pin.sha256}`, [pin])).toThrow();
  });
  it("authenticates the exact Static-Built-Using field alongside the executable pin", () => {
    const selected = { ...pin, builtUsingField: "Static-Built-Using" as const, builtUsing: "fixture-source (= 1.0-1)" };
    expect(() => authenticatePackageIndex(stanza({ "Static-Built-Using": selected.builtUsing }), [selected])).not.toThrow();
    const changes: Record<string, string>[] = [{}, { "Static-Built-Using": "fixture-source (= 2.0-1)" }, { "Built-Using": selected.builtUsing }];
    for (const fields of changes)
      expect(() => authenticatePackageIndex(stanza(fields), [selected])).toThrow(/asset_package_pin/);
  });
  it("authenticates clear-signed metadata with only the pinned signing key", async () => {
    const fixtures = path.resolve("scripts/__tests__/fixtures/runtime-system-assets");
    const release = await readFile(path.join(fixtures, "InRelease"));
    const key = await readFile(path.join(fixtures, "archive-key.asc"));
    const fingerprint = (await readFile(path.join(fixtures, "fingerprint"), "utf8")).trim();
    const verify = (bytes: Buffer, signer = fingerprint) => verifySignedRelease({
      bytes, key, fingerprint: signer, work: temporary.at(-1)!, env: { PATH: process.env.PATH, LANG: "C.UTF-8" },
    });
    await directory();
    expect(await verify(release)).toContain("Origin: Fixture Archive");
    await directory();
    await expect(verify(Buffer.from(release.toString().replace("Fixture Archive", "Foreign Archive")))).rejects.toThrow(/asset_signature/);
    await directory();
    await expect(verify(release, "A".repeat(40))).rejects.toThrow(/asset_signature/);
    await directory();
    await expect(verify(Buffer.from("Origin: Fixture Archive\n"))).rejects.toThrow(/asset_signature/);
  });
});

async function archiveFixture(change?: (lock: any) => void, damage?: string, mirrorMissing = false,
  replacement?: { file: string; bytes: Buffer }) {
  const root = await directory(), fixtures = path.resolve("scripts/__tests__/fixtures/runtime-system-assets");
  const checkout = path.join(root, "checkout"), work = path.join(root, "work"), runtime = path.join(root, "runtime");
  const assets = path.join(checkout, "third_party/runtime-assets"); await mkdir(assets, { recursive: true });
  await mkdir(work); await mkdir(path.join(runtime, "worker/third_party/runtime-assets"), { recursive: true });
  const lock = JSON.parse(await readFile(path.join(fixtures, "lock.json"), "utf8")); change?.(lock);
  delete lock.mirror;
  lock.mirror = `https://github.com/Withso/zeros/releases/download/runtime-assets-${sha256(canonicalJson(lock)).slice(0, 12)}/`;
  await writeFile(path.join(assets, "lock.json"), JSON.stringify(lock));
  await writeFile(path.join(assets, "archive-key.asc"), await readFile(path.join(fixtures, "archive-key.asc")));
  const request = vi.fn(async (url: string) => {
    const mirror = url.startsWith(lock.mirror);
    if (mirror && mirrorMissing) return new Response(null, { status: 404 });
    const pins = [lock.release, ...(lock.additionalReleases ?? []), ...lock.indexes, ...lock.packages.map((pin: any) => ({ ...pin, path: pin.filename }))];
    const pathname = mirror ? pins.find(pin => pin.sha256 === path.basename(url))!.path : new URL(url).pathname;
    const file = pathname.endsWith("fixture-lfs/InRelease") ? "InRelease-lfs" : pathname.endsWith("InRelease") ? "InRelease" :
      pathname.endsWith("Packages.xz") ? "Packages.xz" : path.basename(pathname);
    const bytes = Buffer.from(replacement?.file === file ? replacement.bytes : await readFile(path.join(fixtures, file)));
    if (file === damage) bytes[bytes.length - 1] ^= 1;
    return new Response(bytes);
  });
  vi.stubGlobal("fetch", request);
  return { runtime, request, lock, run: () => stageRuntimeSystemAssets({ checkout, runtime, work, env: { PATH: process.env.PATH, LANG: "C.UTF-8" } }) };
}

describe("build-host asset acquisition", () => {
  it("stages nine synthetic packages through the signed Release → Packages → deb chain", async () => {
    const fixture = await archiveFixture();
    expect(await fixture.run()).toHaveLength(9);
    expect(fixture.request).toHaveBeenCalledTimes(11);
    expect(fixture.request.mock.calls.every(([url]) => url.startsWith(fixture.lock.mirror))).toBe(true);
    expect(JSON.parse(await readFile(path.join(fixture.runtime, "worker/runtime-system-assets.json"), "utf8")).packages).toHaveLength(9);
  });
  it("retains the signed acquisition chain when every mirror asset is absent", async () => {
    const fixture = await archiveFixture(undefined, undefined, true);
    expect(await fixture.run()).toHaveLength(9);
    expect(fixture.request).toHaveBeenCalledTimes(22);
    expect(fixture.request.mock.calls.slice(0, 2).map(([url]) => url)).toEqual([
      `${fixture.lock.mirror}${fixture.lock.release.sha256}`,
      new URL(fixture.lock.release.path, fixture.lock.archive).href,
    ]);
  });
  it("refuses mirror package pins that disagree with the canonical signed index", async () => {
    const fixture = await archiveFixture(lock => { lock.packages[0].sha256 = sha256("untrusted mirror package"); });
    await expect(fixture.run()).rejects.toThrow(/asset_package_pin/);
    expect(fixture.request.mock.calls.every(([url]) => url.startsWith(fixture.lock.mirror))).toBe(true);
  });
  it.each(["InRelease", "Packages.xz", "git-lfs.deb"])("refuses changed %s bytes before using them", async file => {
    const fixture = await archiveFixture(undefined, file);
    await expect(fixture.run()).rejects.toThrow(/asset_download_digest/);
  });
  it("refuses an omitted package index even when the Release and deb hashes are pinned", async () => {
    const fixture = await archiveFixture(lock => { lock.indexes = []; });
    await expect(fixture.run()).rejects.toThrow(/asset_index_set/);
  });
  it("requires the pinned package version to occur in the signed index", async () => {
    const fixture = await archiveFixture(lock => { lock.packages[0].version = "1.2.4-1"; });
    await expect(fixture.run()).rejects.toThrow(/asset_package_pin/);
  });
  it.each(["date", "validUntil"])("requires the pinned Release %s metadata", async field => {
    const fixture = await archiveFixture(lock => { lock.release[field] = "Mon, 12 Oct 2026 00:00:00 UTC"; });
    await expect(fixture.run()).rejects.toThrow(/asset_release/);
  });
  it("refuses a package selecting an unlisted release pocket", async () => {
    const fixture = await archiveFixture(lock => { lock.packages[0].suite = "unlisted"; });
    await expect(fixture.run()).rejects.toThrow(/asset_release/);
    expect(fixture.request).not.toHaveBeenCalled();
  });
  it("refuses missing static notice provenance before acquiring packages", async () => {
    const fixture = await archiveFixture(lock => {
      lock.packages.find((pin: any) => pin.name === "git-lfs").builtUsingField = "Static-Built-Using";
      delete lock.gitLfsNotices;
    });
    await expect(fixture.run()).rejects.toThrow(/asset_package_pin/);
    expect(fixture.request).not.toHaveBeenCalled();
  });
  it("acquires different packages from two authenticated release pockets", async () => {
    const release = JSON.parse(await readFile("scripts/__tests__/fixtures/runtime-system-assets/additional-release.json", "utf8"));
    const fixture = await archiveFixture(lock => {
      lock.additionalReleases = [release];
      lock.packages.find((pin: any) => pin.name === "git-lfs").suite = release.suite;
      lock.indexes.push({ ...lock.indexes[0], path: `dists/${release.suite}/universe/binary-amd64/Packages.xz` });
    });
    expect(await fixture.run()).toHaveLength(9);
    expect(fixture.request).toHaveBeenCalledTimes(13);
    expect(await readFile(path.join(fixture.runtime, `worker/third_party/runtime-assets/InRelease.${release.suite}`))).toEqual(
      await readFile("scripts/__tests__/fixtures/runtime-system-assets/InRelease-lfs"));
  });
  it("requires the second pocket's own valid signature", async () => {
    const release = JSON.parse(await readFile("scripts/__tests__/fixtures/runtime-system-assets/additional-release.json", "utf8"));
    const bytes = Buffer.from((await readFile("scripts/__tests__/fixtures/runtime-system-assets/InRelease-lfs", "utf8"))
      .replace("Fixture Archive", "Foreign Archive"));
    const fixture = await archiveFixture(lock => {
      lock.additionalReleases = [{ ...release, size: bytes.length, sha256: sha256(bytes) }];
      lock.packages.find((pin: any) => pin.name === "git-lfs").suite = release.suite;
      lock.indexes.push({ ...lock.indexes[0], path: `dists/${release.suite}/universe/binary-amd64/Packages.xz` });
    }, undefined, false, { file: "InRelease-lfs", bytes });
    await expect(fixture.run()).rejects.toThrow(/asset_signature/);
  });
});

async function extractedFixture() {
  const root = await directory(), extracted = path.join(root, "extracted"), runtime = path.join(root, "runtime");
  await mkdir(path.join(extracted, "git-lfs/usr/bin"), { recursive: true });
  await mkdir(path.join(extracted, "git-lfs/usr/share/doc/git-lfs"), { recursive: true });
  await writeFile(path.join(extracted, "git-lfs/usr/bin/git-lfs"), await readFile(process.execPath), { mode: 0o755 });
  await writeFile(path.join(extracted, "git-lfs/usr/share/doc/git-lfs/copyright"), "fixture terms");
  const fonts = ["fonts-noto-color-emoji", "fonts-unifont", "xfonts-cyrillic", "xfonts-scalable",
    "fonts-ipafont-gothic", "fonts-wqy-zenhei", "fonts-tlwg-loma-otf", "fonts-freefont-ttf"];
  for (const name of fonts) {
    await mkdir(path.join(extracted, `${name}/usr/share/fonts/${name}`), { recursive: true });
    await writeFile(path.join(extracted, `${name}/usr/share/fonts/${name}/fixture.ttf`), `font-${name}`);
    await mkdir(path.join(extracted, `${name}/usr/share/doc/${name}`), { recursive: true });
    await writeFile(path.join(extracted, `${name}/usr/share/doc/${name}/copyright`), "fixture terms");
  }
  const packages = [pin, ...fonts.map(name => ({ ...pin, name, architecture: "all" as const }))];
  await mkdir(runtime);
  const options = { runtime, packages, extracted: new Map(packages.map(p => [p.name, path.join(extracted, p.name)])) };
  return { root, runtime, extracted, options };
}

async function verifySlimBaseConsumer(runtime: string, rejected?: string) {
  // Only unrelated engine entrypoints are synthetic; system assets come from
  // the production stager and use its real inventory/archive implementation.
  for (const name of ["bin/node", "bin/start-engine.sh", "lib/zeros/setup-cloud-workspace.mjs",
    "lib/zeros/cloud-worker-supervisor.mjs", "lib/zeros/runtime-self-test.mjs", "worker/dist-engine/cli.js"]) {
    await mkdir(path.dirname(path.join(runtime, name)), { recursive: true, mode: 0o755 });
    await writeFile(path.join(runtime, name), "synthetic engine entrypoint\n", { flag: "wx", mode: 0o555 });
  }
  const header = JSON.parse(await readFile("packages/protocol/src/__tests__/fixtures/cloud-runtime/manifest.valid.json", "utf8"));
  const manifest = createManifest({ source: header.source, agents: header.agents, engineProtocolVersion: header.protocols.engine }, await inventoryTree(runtime));
  const bytes = canonicalJson(manifest), manifestSha256 = sha256(bytes);
  const output = await directory(), archive = path.join(output, "runtime.tar.gz"), descriptor = path.join(output, "descriptor.json");
  await writeRuntimeArchive(runtime, bytes, archive);
  await writeFile(descriptor, JSON.stringify({
    runtimeId: `r1-${manifestSha256}`, manifestSha256, archiveSha256: await sha256File(archive),
    archiveBytes: (await readFile(archive)).length,
    expandedBytes: manifest.files.reduce((sum, entry) => sum + (entry.type === "file" ? entry.size : 0), 0),
    sourceCommit: manifest.source.commit, nodeModulesAbi: manifest.platform.nodeModulesAbi,
    bootstrapProtocolVersion: manifest.protocols.bootstrap, engineProtocolVersion: manifest.protocols.engine,
  }));
  try {
    const result = await runTool("python3", ["-B", "scripts/cloud-workspace-validation/runtime-base-v4/tests/verify_produced_assets.py",
      archive, descriptor, ...(rejected ? [rejected] : [])], { cwd: process.cwd(), env: { PATH: process.env.PATH }, timeout: 90_000 }, "asset_base_contract");
    return JSON.parse(result);
  } catch (error) {
    // This child has only fixture data and the explicit PATH above.
    throw new Error(`Slim-base fixture failed: ${(error as { toolOutput?: string }).toolOutput ?? "asset_base_contract"}`);
  }
}

describe("runtime producer and slim-base consumer", () => {
  it("installs the produced assets, verifies cached/full/dispatch paths and selects them for Computer recipes", async () => {
    const fixture = await archiveFixture();
    await fixture.run();
    expect(await verifySlimBaseConsumer(fixture.runtime)).toMatchObject({
      installed: true, cached: true, fullVerified: true, dispatched: true, bootDispatched: true,
      computerEnvironment: true, derivedGitExecExcluded: true, packages: 9, copyrights: 9, fonts: 8,
      dispatchRehashed: ["bin/git-lfs", "worker/gitconfig", "worker/design-fonts/fonts.conf", "worker/runtime-system-assets.json"],
      fullRehashed: expect.arrayContaining(["lib/runtime-system-assets/git-lfs/copyright"]),
    });
  });
  it("refuses a legacy archive without the asset capability", async () => {
    const fixture = await archiveFixture();
    expect(await verifySlimBaseConsumer(fixture.runtime, "file_inventory")).toEqual({ rejected: "file_inventory" });
  });
  it.each(["writable LFS", "missing package", "missing copyright", "missing font"])("refuses %s even with a valid producer manifest and archive digest", async damage => {
    const fixture = await archiveFixture(); await fixture.run();
    const inventory = path.join(fixture.runtime, "worker/runtime-system-assets.json");
    const assets = JSON.parse(await readFile(inventory, "utf8"));
    if (damage === "writable LFS") await chmod(path.join(fixture.runtime, "bin/git-lfs"), 0o755);
    if (damage === "missing package") {
      assets.packages.pop(); await chmod(inventory, 0o644);
      await writeFile(inventory, canonicalJson(assets)); await chmod(inventory, 0o444);
    }
    if (damage === "missing copyright") await rm(path.join(fixture.runtime, "lib/runtime-system-assets/git-lfs/copyright"));
    if (damage === "missing font") await rm(path.join(fixture.runtime, assets.fonts[0]));
    const rejected = damage === "writable LFS" ? "file_mode" : "file_inventory";
    expect(await verifySlimBaseConsumer(fixture.runtime, rejected)).toEqual({ rejected });
  });
  // Optional real-byte proof. Every download is intercepted by a digest-keyed
  // offline cache; even a missing cache entry cannot reach the network.
  it.runIf(!!process.env.ZEROS_RUNTIME_SYSTEM_ASSETS_CACHE)("passes real pinned deb assets through the same producer and slim-base gates offline", async () => {
    const root = await directory(), runtime = path.join(root, "runtime"), work = path.join(root, "work");
    await mkdir(work); await mkdir(path.join(runtime, "worker/third_party/runtime-assets"), { recursive: true });
    const lock = JSON.parse(await readFile("third_party/runtime-assets/lock.json", "utf8"));
    const pins = [lock.release, ...(lock.additionalReleases ?? []), ...lock.indexes, ...lock.packages.map((pin: any) => ({ ...pin, path: pin.filename })),
      ...lock.sources.flatMap((source: any) => source.files)];
    const requests = new Map<string, string>(pins.flatMap(pin => [
      [`${lock.mirror}${pin.sha256}`, pin.sha256], [new URL(pin.path, lock.archive).href, pin.sha256],
    ]));
    const request = vi.fn(async (url: string) => {
      const digest = requests.get(url); expect(digest).toBeDefined();
      return new Response(await readFile(path.join(process.env.ZEROS_RUNTIME_SYSTEM_ASSETS_CACHE!, digest!)));
    });
    vi.stubGlobal("fetch", request);
    // The real bundle copies vendored notices/small retained sources first.
    for (const pin of lock.gitLfsNotices.retainedSource) {
      const target = path.join(runtime, "worker/third_party/runtime-assets", pin.file);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.join("third_party/runtime-assets", pin.file), target); await chmod(target, 0o444);
    }
    expect(await stageRuntimeSystemAssets({ checkout: process.cwd(), runtime, work, env: { PATH: process.env.PATH, LANG: "C.UTF-8" } })).toHaveLength(9);
    expect(request).toHaveBeenCalledTimes(pins.length);
    const result = await verifySlimBaseConsumer(runtime);
    expect(result).toMatchObject({ installed: true, cached: true, fullVerified: true, dispatched: true,
      bootDispatched: true, computerEnvironment: true, derivedGitExecExcluded: true, packages: 9, copyrights: 9 });
    expect(result.fonts).toBeGreaterThanOrEqual(117);
    expect(result.dispatchRehashed).toHaveLength(4);
    expect(result.fullRehashed).toHaveLength(6);
  }, 120_000);
});

describe("immutable runtime system assets", () => {
  it("stages real font bytes, LFS, configuration and provenance before inventory and ABI inspection", async () => {
    const fixture = await extractedFixture();
    const packages = await stageExtractedSystemAssets(fixture.options);
    expect(packages.map(p => p.name).sort()).toEqual(fixture.options.packages.map(p => p.name).sort());
    const entries = await inventoryTree(fixture.runtime);
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "bin/git-lfs", type: "file", mode: "0555" }),
      expect.objectContaining({ path: "worker/runtime-system-assets.json", type: "file" }),
      expect.objectContaining({ path: "worker/gitconfig", type: "file" }),
      expect.objectContaining({ path: "worker/design-fonts/fonts.conf", type: "file" }),
    ]));
    const inventory = JSON.parse(await readFile(path.join(fixture.runtime, "worker/runtime-system-assets.json"), "utf8"));
    expect(inventory.schema).toBe("zeros.runtime-system-assets/v1");
    expect(inventory.fonts).toHaveLength(8);
    expect(inventory.packages).toEqual(fixture.options.packages);
    const config = await readFile(path.join(fixture.runtime, "worker/design-fonts/fonts.conf"), "utf8");
    expect(config).toContain('<dir prefix="relative">.</dir>');
    expect(config).toContain('<cachedir prefix="xdg">fontconfig</cachedir>');
    expect(config).not.toContain(fixture.root);
    const gitConfig = await readFile(path.join(fixture.runtime, "worker/gitconfig"), "utf8");
    expect(gitConfig).toContain("${GIT_CONFIG_SYSTEM%/worker/gitconfig}/bin/git-lfs");
    expect(gitConfig).not.toContain(fixture.root);
    expect(gitConfig).not.toMatch(/= git-lfs /);
    // The selected executable participates in the same ELF walk as Node.
    await writeFile(path.join(fixture.runtime, "bin/node"), await readFile(process.execPath), { mode: 0o555 });
    const requirements = await inspectNativeRequirements(fixture.runtime, await inventoryTree(fixture.runtime), { PATH: process.env.PATH });
    expect(requirements.some(file => file.path === "bin/git-lfs")).toBe(true);
    const before = entries.find(file => file.path.endsWith("fixture.ttf"))!;
    await chmod(path.join(fixture.runtime, before.path), 0o644);
    await writeFile(path.join(fixture.runtime, before.path), "changed font");
    await chmod(path.join(fixture.runtime, before.path), 0o444);
    expect((await inventoryTree(fixture.runtime)).find(file => file.path === before.path)).not.toEqual(before);
  });
  it("refuses missing fonts, missing LFS and changed copyright bytes", async () => {
    for (const missing of ["git-lfs/usr/bin/git-lfs", "fonts-unifont/usr/share/fonts", "git-lfs/usr/share/doc/git-lfs/copyright"]) {
      const fixture = await extractedFixture();
      await rm(path.join(fixture.extracted, missing), { recursive: true });
      await expect(stageExtractedSystemAssets(fixture.options)).rejects.toThrow();
    }
    const fixture = await extractedFixture();
    await writeFile(path.join(fixture.extracted, "git-lfs/usr/share/doc/git-lfs/copyright"), "changed terms");
    await expect(stageExtractedSystemAssets(fixture.options)).rejects.toThrow(/asset_copyright/);
  });
  it("refuses executable symlinks instead of copying outside the extracted package", async () => {
    const fixture = await extractedFixture();
    await rm(path.join(fixture.extracted, "git-lfs/usr/bin/git-lfs"));
    await symlink(process.execPath, path.join(fixture.extracted, "git-lfs/usr/bin/git-lfs"));
    await expect(stageExtractedSystemAssets(fixture.options)).rejects.toThrow(/asset_file/);
  });
  it("validates tar members before dpkg-deb extraction and never runs package scripts", async () => {
    const root = await directory(), pkg = path.join(root, "pkg"), archive = path.join(root, "fixture.deb");
    await mkdir(path.join(pkg, "DEBIAN"), { recursive: true });
    await writeFile(path.join(pkg, "DEBIAN/control"), "Package: fixture\nVersion: 1.0\nArchitecture: all\nMaintainer: Fixture <fixture@example.invalid>\nDescription: fixture\n");
    await writeFile(path.join(pkg, "DEBIAN/postinst"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
    await mkdir(path.join(pkg, "usr/share/fonts"), { recursive: true });
    await writeFile(path.join(pkg, "usr/share/fonts/fixture.ttf"), "font fixture");
    execFileSync("dpkg-deb", ["--root-owner-group", "--build", pkg, archive], { stdio: "ignore" });
    const command = { cwd: root, env: { PATH: process.env.PATH } };
    await extractRuntimeDeb(archive, path.join(root, "safe"), command);
    expect(await readFile(path.join(root, "safe/usr/share/fonts/fixture.ttf"), "utf8")).toBe("font fixture");
    await symlink("../../../../escaped", path.join(pkg, "usr/share/fonts/escape"));
    execFileSync("dpkg-deb", ["--root-owner-group", "--build", pkg, archive], { stdio: "ignore" });
    await expect(extractRuntimeDeb(archive, path.join(root, "unsafe"), command)).rejects.toThrow(/asset_deb/);
  });
});
