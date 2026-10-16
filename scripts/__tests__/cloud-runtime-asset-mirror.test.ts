import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { canonicalJson, sha256 } from "../cloud-workspace-validation/runtime-bundle/manifest";
import { downloadRuntimeAsset, downloadVerifiedAsset, runtimeAssetFiles, runtimeAssetLockIdentity } from "../cloud-workspace-validation/runtime-bundle/asset-files.mjs";
import { mirrorRuntimeAssets, planRuntimeAssetMirror } from "../cloud-workspace-validation/runtime-bundle/mirror-assets.mjs";

const bytes = Buffer.from("synthetic pinned archive"), digest = sha256(bytes);
const pin = { url: "https://archive.ubuntu.com/ubuntu/pool/main/f/fixture.deb", size: bytes.length, sha256: digest };
const mirror = "https://github.com/Withso/zeros/releases/download/runtime-assets-0123456789ab/";
const signedCdn = "https://release-assets.githubusercontent.com/github-production-release-asset/123456789/01234567-89ab-cdef-0123-456789abcdef?sp=r&sv=2018-11-09&sr=b&spr=https&se=2030-01-01T00%3A00%3A00Z&rscd=attachment%3B+filename%3Dfixture&sig=synthetic-signature";
const forbiddenUrls = [
  "https://127.0.0.1/private-fixture", "https://127.0.0.1:8443/private-fixture", "https://[::1]/private-fixture",
  "https://10.0.0.1/private-fixture", "https://172.16.0.1/private-fixture", "https://192.168.0.1/private-fixture",
  "https://169.254.169.254/private-fixture", "https://localhost/private-fixture", "https://internal.example.test/private-fixture",
  "https://archive.ubuntu.com.example.test/fixture", "https://release-assets.githubusercontent.com.example.test/fixture",
  "https://github.com./fixture", "https://api.github.com/fixture", "https://security.ubuntu.com/fixture",
  "https://archive.ubuntu.com:8443/fixture", "https://github.com:444/fixture",
  "https://fixture-user:fixture-password@archive.ubuntu.com/fixture", "https://fixture-user@github.com/fixture",
  "http://archive.ubuntu.com/fixture", "https://github.com/fixture#fragment",
];

describe("verified runtime asset downloads", () => {
  it("includes an additional Release in the verified mirror plan", () => {
    const release = { path: "dists/fixture/InRelease", sha256: digest, size: bytes.length };
    const additional = { path: "dists/fixture-lfs/InRelease", sha256: sha256("additional release"), size: 18 };
    const files = runtimeAssetFiles({ schema: "zeros.runtime-system-assets-lock/v1", archive: "https://archive.ubuntu.com/ubuntu/",
      release, additionalReleases: [additional], indexes: [], packages: [], sources: [] });
    expect(files).toHaveLength(2);
    expect(files).toContainEqual({ ...additional, url: `https://archive.ubuntu.com/ubuntu/${additional.path}` });
  });
  it("uses the content-addressed mirror first and logs only source and digest", async () => {
    const fetcher = vi.fn(async () => new Response(bytes)), log = vi.fn();
    expect(await downloadRuntimeAsset(pin, { mirror, fetch: fetcher, log })).toEqual(bytes);
    expect(fetcher).toHaveBeenCalledOnce(); expect(fetcher.mock.calls[0][0]).toBe(`${mirror}${digest}`);
    expect(log).toHaveBeenCalledWith(`runtime_asset mirror ${digest}`);
  });
  it.each(["404", "network", "digest", "oversize"])("falls back after a mirror %s and verifies the canonical bytes", async failure => {
    const fetcher = vi.fn(async (url: string) => {
      if (url === pin.url) return new Response(bytes);
      if (failure === "network") throw new Error("private transport detail");
      return failure === "404" ? new Response(null, { status: 404 }) :
        new Response(failure === "digest" ? Buffer.alloc(bytes.length) : Buffer.concat([bytes, Buffer.from("x")]));
    });
    const log = vi.fn();
    expect(await downloadRuntimeAsset(pin, { mirror, fetch: fetcher, log })).toEqual(bytes);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([`${mirror}${digest}`, pin.url]);
    expect(log.mock.calls).toEqual([[`runtime_asset canonical ${digest}`]]);
  });
  it.each(["404", "network", "digest", "oversize"])("fails closed when canonical %s follows a failed mirror", async failure => {
    const fetcher = vi.fn(async (url: string) => {
      if (url !== pin.url || failure === "404") return new Response(null, { status: 404 });
      if (failure === "network") throw new Error("private transport detail");
      return new Response(failure === "digest" ? Buffer.alloc(bytes.length) : Buffer.concat([bytes, Buffer.from("x")]));
    });
    const log = vi.fn();
    await expect(downloadRuntimeAsset(pin, { mirror, fetch: fetcher, log })).rejects.toThrow(/^asset_download/);
    expect(fetcher).toHaveBeenCalledTimes(2); expect(log).not.toHaveBeenCalled();
  });
  it("never accepts canonical-mismatched bytes or a mirror's self-reported checksum", async () => {
    const forged = Buffer.alloc(bytes.length), log = vi.fn();
    const fetcher = vi.fn(async (url: string) => url === pin.url ? new Response(null, { status: 503 }) :
      new Response(forged, { headers: { "x-checksum-sha256": sha256(forged), "content-length": String(bytes.length) } }));
    await expect(downloadRuntimeAsset(pin, { mirror, fetch: fetcher, log })).rejects.toThrow("asset_download");
    expect(log).not.toHaveBeenCalled();
  });
  it("follows bounded HTTPS release redirects without disclosing signed CDN URLs", async () => {
    const redirected = signedCdn;
    const fetcher = vi.fn(async (url: string, _options?: RequestInit) => url === redirected ? new Response(bytes) :
      new Response(null, { status: 302, headers: { location: redirected } }));
    const log = vi.fn();
    expect(await downloadRuntimeAsset(pin, { mirror, fetch: fetcher, log })).toEqual(bytes);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([`${mirror}${digest}`, redirected]);
    expect(JSON.stringify(log.mock.calls)).not.toContain("signature");
    expect(JSON.stringify(log.mock.calls)).not.toContain("https:");
    for (const [, options] of fetcher.mock.calls) expect(options).toMatchObject({ credentials: "omit", redirect: "manual", signal: expect.any(AbortSignal) });
  });
  it.each(forbiddenUrls)("refuses initial %s before invoking the fetcher", async url => {
    const fetcher = vi.fn(async () => new Response(bytes));
    await expect(downloadVerifiedAsset(url, pin, { fetch: fetcher })).rejects.toThrow("asset_download_redirect");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(forbiddenUrls)("refuses every redirect to %s before invoking the fetcher for it", async url => {
    for (const initial of [pin.url, `${mirror}${digest}`]) for (const intermediate of [false, true]) {
      const fetcher = vi.fn(async (target: string) => target === url ? new Response(bytes) :
        new Response(null, { status: 302, headers: { location: intermediate && target === initial ? signedCdn : url } }));
      await expect(downloadVerifiedAsset(initial, pin, { fetch: fetcher })).rejects.toThrow("asset_download_redirect");
      expect(fetcher.mock.calls.map(([target]) => target)).toEqual(intermediate ? [initial, signedCdn] : [initial]);
    }
  });
  it.each(["archive.ubuntu.com", "snapshot.ubuntu.com", "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"])("accepts the reviewed %s host at the default HTTPS port", async host => {
    const fetcher = vi.fn(async (_url: string) => new Response(bytes));
    expect(await downloadVerifiedAsset(`https://${host}:443/fixture`, pin, { fetch: fetcher })).toEqual(bytes);
    expect(fetcher.mock.calls[0][0]).toBe(`https://${host}/fixture`);
  });
  it("falls back after an unsafe mirror redirect and closes after an unsafe canonical redirect", async () => {
    const redirected = forbiddenUrls[8]!;
    const fetcher = vi.fn(async (url: string) => url === pin.url ? new Response(bytes) :
      new Response(null, { status: 302, headers: { location: redirected } }));
    expect(await downloadRuntimeAsset(pin, { mirror, fetch: fetcher, log: vi.fn() })).toEqual(bytes);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([`${mirror}${digest}`, pin.url]);
    fetcher.mockClear().mockImplementation(async url => url === pin.url ?
      new Response(null, { status: 302, headers: { location: redirected } }) : new Response(null, { status: 404 }));
    await expect(downloadRuntimeAsset(pin, { mirror, fetch: fetcher, log: vi.fn() })).rejects.toThrow("asset_download_redirect");
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([`${mirror}${digest}`, pin.url]);
  });
  it("refuses HTTP redirects, redirect loops and oversized content-length headers", async () => {
    for (const response of [() => new Response(null, { status: 302, headers: { location: "http://example.invalid/fixture" } }),
      () => new Response(null, { status: 302, headers: { location: pin.url } }),
      () => new Response(bytes, { headers: { "content-length": String(bytes.length + 1) } })]) {
      const fetcher = vi.fn(async () => response());
      await expect(downloadVerifiedAsset(pin.url, pin, { fetch: fetcher })).rejects.toThrow(/^asset_download/);
      expect(fetcher.mock.calls.length).toBeLessThanOrEqual(6);
    }
  });
});

describe("runtime asset lock identity", () => {
  it("hashes canonical JSON recursively, excluding only the top-level mirror", () => {
    const value = { b: [3, 2], a: { z: "fixture", n: 1 } };
    const expected = sha256(canonicalJson(value));
    expect(runtimeAssetLockIdentity(value)).toEqual({ sha256: expected, lock12: expected.slice(0, 12),
      tag: `runtime-assets-${expected.slice(0, 12)}`, mirror: `https://github.com/Withso/zeros/releases/download/runtime-assets-${expected.slice(0, 12)}/` });
    expect(runtimeAssetLockIdentity({ mirror: "excluded", a: { n: 1, z: "fixture" }, b: [3, 2] })).toEqual(runtimeAssetLockIdentity(value));
    expect(runtimeAssetLockIdentity({ ...value, b: [2, 3] })).not.toEqual(runtimeAssetLockIdentity(value));
    expect(runtimeAssetLockIdentity({ ...value, a: { ...value.a, mirror: "included" } })).not.toEqual(runtimeAssetLockIdentity(value));
  });
  it("covers InRelease, all indexes/debs and retained GPL/MPL source/build archives", async () => {
    const lock = JSON.parse(await readFile("third_party/runtime-assets/lock.json", "utf8"));
    const files = runtimeAssetFiles(lock);
    expect(lock.mirror).toBe(runtimeAssetLockIdentity(lock).mirror);
    expect(files).toHaveLength(33);
    expect(new Set(files.map(file => file.sha256)).size).toBe(33);
    for (const pin of [lock.release, ...lock.additionalReleases, ...lock.indexes, ...lock.packages,
      ...lock.sources.flatMap((source: any) => source.files), ...lock.gitLfsNotices.retainedSource])
      expect(files).toContainEqual(expect.objectContaining({ sha256: pin.sha256, size: pin.size }));
  });
});

async function publicationFixture() {
  const second = Buffer.from("synthetic retained source");
  const lock: any = { schema: "zeros.runtime-system-assets-lock/v1", archive: "https://archive.ubuntu.com/ubuntu/",
    release: { path: "dists/noble/InRelease", size: bytes.length, sha256: digest }, indexes: [], packages: [],
    sources: [{ files: [{ path: "pool/main/f/fixture/fixture.orig.tar.gz", size: second.length, sha256: sha256(second) }] }] };
  lock.mirror = runtimeAssetLockIdentity(lock).mirror;
  const plan = planRuntimeAssetMirror(lock), files = runtimeAssetFiles(lock);
  const contents = new Map([[digest, bytes], [sha256(second), second]]);
  const state = { release: false, published: new Set<string>(), corrupt: false, wrongCanonical: false };
  const fetcher = vi.fn(async (url: string) => {
    if (url.startsWith("https://api.github.com/")) return state.release ? Response.json({ tag_name: plan.tag, prerelease: true,
      draft: false, body: plan.notes, assets: [...state.published].map(name => ({ name })) }) : new Response(null, { status: 404 });
    if (url.startsWith(plan.mirror)) {
      const name = url.slice(plan.mirror.length);
      return state.published.has(name) ? new Response(state.corrupt ? Buffer.from("corrupt") : contents.get(name)!) : new Response(null, { status: 404 });
    }
    const file = files.find(file => file.url === url);
    if (!file) throw new Error("Unexpected fixture request");
    return new Response(state.wrongCanonical ? Buffer.from("corrupt") : contents.get(file.sha256)!);
  });
  const gh = vi.fn(async (args: string[]) => {
    expect(args[args.indexOf("--repo") + 1]).toBe("github.com/Withso/zeros");
    if (args[1] === "create") {
      expect(await readFile(args[args.indexOf("--notes-file") + 1], "utf8")).toBe(plan.notes);
      state.release = true;
    }
    else if (args[1] === "upload") {
      for (const filename of args.slice(3, args.indexOf("--repo"))) {
        const name = path.basename(filename);
        expect(await readFile(filename)).toEqual(contents.get(name));
        state.published.add(name);
      }
    } else throw new Error("Unexpected fixture write");
  });
  return { lock, plan, files, state, fetcher, gh, run: (apply = false) => mirrorRuntimeAssets(lock, { apply, fetch: fetcher, gh, log: vi.fn() }) };
}

describe("maintainer asset mirror", () => {
  it("defaults to a complete offline dry-run plan without network or gh writes", async () => {
    const fixture = await publicationFixture();
    expect(await fixture.run()).toEqual(fixture.plan);
    expect(fixture.fetcher).not.toHaveBeenCalled(); expect(fixture.gh).not.toHaveBeenCalled();
    const output = execFileSync(process.execPath, ["scripts/cloud-workspace-validation/runtime-bundle/mirror-assets.mjs"], { encoding: "utf8" });
    expect(output).toContain("dry-run"); expect(output).toContain("33 files"); expect(output).toContain("--apply");
  });
  it("downloads canonical verified bytes before creating a marked prerelease and uploading missing assets", async () => {
    const fixture = await publicationFixture();
    await fixture.run(true);
    expect(fixture.gh.mock.calls.map(([args]) => args.slice(0, 3))).toEqual([
      ["release", "create", fixture.plan.tag], ["release", "upload", fixture.plan.tag],
    ]);
    expect(fixture.gh.mock.calls[0][0]).toContain("--prerelease");
    expect(fixture.gh.mock.calls[0][0]).toContain("--latest=false");
    expect(fixture.gh.mock.calls[1][0]).not.toContain("--clobber");
    expect(fixture.state.published.size).toBe(2);
    expect(fixture.fetcher.mock.calls.slice(0, 2).map(([url]) => url).sort()).toEqual(fixture.files.map(file => file.url).sort());
  });
  it("verifies and skips existing assets on a second apply", async () => {
    const fixture = await publicationFixture(); await fixture.run(true);
    fixture.fetcher.mockClear(); fixture.gh.mockClear();
    await fixture.run(true);
    expect(fixture.gh).not.toHaveBeenCalled();
    for (const file of fixture.files) expect(fixture.fetcher.mock.calls.map(([url]) => url)).toContain(`${fixture.plan.mirror}${file.sha256}`);
  });
  it("completes a partially populated mirror without replacing existing assets", async () => {
    const fixture = await publicationFixture(); fixture.state.release = true;
    fixture.state.published.add(fixture.files[0].sha256);
    await fixture.run(true);
    expect(fixture.gh).toHaveBeenCalledOnce();
    const args = fixture.gh.mock.calls[0][0];
    expect(args.slice(0, 3)).toEqual(["release", "upload", fixture.plan.tag]);
    expect(args.slice(3, args.indexOf("--repo")).map(filename => path.basename(filename))).toEqual([fixture.files[1].sha256]);
  });
  it("refuses malformed release metadata without treating it as a missing release", async () => {
    const fixture = await publicationFixture();
    await expect(mirrorRuntimeAssets(fixture.lock, { apply: true, gh: fixture.gh, log: vi.fn(),
      fetch: async url => url.startsWith("https://api.github.com/") ? Response.json(null) : fixture.fetcher(url),
    })).rejects.toThrow("asset_mirror_release");
    expect(fixture.gh).not.toHaveBeenCalled();
  });
  it.each(["canonical", "mirror", "metadata"])("refuses an unsafe %s redirect before publication or a foreign fetch", async source => {
    const fixture = await publicationFixture(), redirected = forbiddenUrls[8]!;
    fixture.state.release = true; fixture.files.forEach(file => fixture.state.published.add(file.sha256));
    const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === redirected) return new Response(bytes);
      if (source === "canonical" && fixture.files.some(file => file.url === url) ||
        source === "mirror" && url.startsWith(fixture.plan.mirror) || source === "metadata" && url.startsWith("https://api.github.com/")) {
        if (source === "metadata") expect(options).toMatchObject({ redirect: "error", credentials: "omit", signal: expect.any(AbortSignal) });
        return new Response(null, { status: 302, headers: { location: redirected } });
      }
      return fixture.fetcher(url);
    });
    await expect(mirrorRuntimeAssets(fixture.lock, { apply: true, gh: fixture.gh, fetch: fetcher, log: vi.fn() })).rejects.toThrow(/^asset_/);
    expect(fetcher.mock.calls.map(([url]) => url)).not.toContain(redirected);
    expect(fixture.gh).not.toHaveBeenCalled();
  });
  it("refuses changed existing assets, bad canonical bytes and stale mirror fields before writes", async () => {
    for (const failure of ["existing", "canonical", "stale"]) {
      const fixture = await publicationFixture();
      if (failure === "existing") { fixture.state.release = true; fixture.state.corrupt = true; fixture.files.forEach(file => fixture.state.published.add(file.sha256)); }
      if (failure === "canonical") fixture.state.wrongCanonical = true;
      if (failure === "stale") fixture.lock.mirror = `${mirror}`;
      await expect(fixture.run(true)).rejects.toThrow(/^asset_/);
      expect(fixture.gh).not.toHaveBeenCalled();
    }
  });
});
