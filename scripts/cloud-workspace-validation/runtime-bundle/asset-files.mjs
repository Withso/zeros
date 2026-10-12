import { createHash } from "node:crypto";

export class RuntimeAssetError extends Error {
  constructor(check) { super(check); this.check = check; }
}
const check = (condition, code) => { if (!condition) throw new RuntimeAssetError(code); };
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const safePath = value => typeof value === "string" && /^[A-Za-z0-9_+./-]+$/.test(value) &&
  !value.startsWith("/") && value.split("/").every(part => part !== "" && part !== "." && part !== "..");
function pinned(pin) {
  check(pin && /^[a-f0-9]{64}$/.test(pin.sha256) && Number.isSafeInteger(pin.size) &&
    pin.size > 0 && pin.size <= 128 * 1024 * 1024, "asset_lock");
}

const archiveHosts = new Set(["archive.ubuntu.com", "snapshot.ubuntu.com"]);
const downloadHosts = new Set([...archiveHosts, "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"]);
const metadataHosts = new Set(["api.github.com"]);

/** Check before any network request, including each redirect. Snapshot is used
 * by the lock's retained MPL sources; no other archive or wildcard CDN is allowed. */
export function checkedRuntimeAssetUrl(value, purpose = "download") {
  try {
    const target = new URL(value);
    const hosts = purpose === "download" ? downloadHosts : purpose === "archive" ? archiveHosts :
      purpose === "release-metadata" ? metadataHosts : null;
    check(target.protocol === "https:" && !target.port && !target.username && !target.password && !target.hash &&
      hosts?.has(target.hostname), "asset_download_redirect");
    return target;
  } catch { throw new RuntimeAssetError("asset_download_redirect"); }
}

/** The same sorted, compact JSON contract as the bundle manifest, without
 * changing its serializer. Only the top-level mirror is excluded. */
export function runtimeAssetLockIdentity(lock) {
  const canonical = value => {
    if (value === null || typeof value === "boolean" || typeof value === "string") return value;
    if (typeof value === "number") { check(Number.isFinite(value), "asset_lock"); return value; }
    if (Array.isArray(value)) return value.map(canonical);
    check(value && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value)), "asset_lock");
    const sorted = Object.create(null);
    for (const key of Object.keys(value).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      check(/^[\x20-\x7e]+$/.test(key), "asset_lock"); sorted[key] = canonical(value[key]);
    }
    return sorted;
  };
  check(lock && typeof lock === "object" && !Array.isArray(lock), "asset_lock");
  const body = Object.fromEntries(Object.entries(lock).filter(([key]) => key !== "mirror"));
  const digest = sha256(JSON.stringify(canonical(body))), lock12 = digest.slice(0, 12), tag = `runtime-assets-${lock12}`;
  return { sha256: digest, lock12, tag, mirror: `https://github.com/Withso/zeros/releases/download/${tag}/` };
}

/** Every build download, plus the vendored MPL source/build files. Notices
 * already checked into the repository do not cause additional build fetches. */
export function runtimeAssetFiles(lock) {
  check(lock?.schema === "zeros.runtime-system-assets-lock/v1" && lock.archive === "https://archive.ubuntu.com/ubuntu/" &&
    Array.isArray(lock.indexes) && Array.isArray(lock.packages) && Array.isArray(lock.sources) &&
    (lock.additionalReleases === undefined || Array.isArray(lock.additionalReleases)), "asset_lock");
  const files = new Map();
  const add = (pin, name = pin?.path, url) => {
    pinned(pin); check(safePath(name), "asset_lock");
    let source;
    try { source = checkedRuntimeAssetUrl(new URL(url ?? name, lock.archive).href, "archive"); }
    catch { throw new RuntimeAssetError("asset_lock"); }
    check(!source.search, "asset_lock");
    const previous = files.get(pin.sha256);
    check(!previous || previous.size === pin.size, "asset_lock");
    if (!previous) files.set(pin.sha256, { path: name, size: pin.size, sha256: pin.sha256, url: source.href });
  };
  add(lock.release);
  for (const pin of lock.additionalReleases ?? []) add(pin);
  for (const pin of lock.indexes) add(pin);
  for (const pin of lock.packages) add(pin, pin.filename);
  for (const source of lock.sources) for (const pin of source.files) add(pin);
  for (const pin of lock.gitLfsNotices?.retainedSource ?? []) add(pin, pin.file, pin.url);
  return [...files.values()].sort((a, b) => a.sha256.localeCompare(b.sha256));
}

/** No response bytes are returned until their exact pinned length and hash
 * pass. HTTPS redirects support GitHub's public asset CDN without credentials. */
export async function downloadVerifiedAsset(url, pin, { fetch: fetcher = globalThis.fetch } = {}) {
  pinned(pin);
  try {
    const signal = AbortSignal.timeout(120_000);
    for (let redirects = 0; redirects <= 5; redirects++) {
      const target = checkedRuntimeAssetUrl(url);
      const response = await fetcher(target.href, { redirect: "manual", credentials: "omit", signal });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel().catch(() => {});
        const location = response.headers.get("location");
        check(location && redirects < 5, "asset_download_redirect"); url = new URL(location, target).href; continue;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => {}); throw new RuntimeAssetError("asset_download");
      }
      const advertised = response.headers.get("content-length");
      if (advertised !== null && (!/^\d+$/.test(advertised) || Number(advertised) > pin.size)) {
        await response.body.cancel().catch(() => {}); throw new RuntimeAssetError("asset_download_size");
      }
      const chunks = []; let length = 0;
      for await (const chunk of response.body) {
        length += chunk.length; check(length <= pin.size, "asset_download_size"); chunks.push(Buffer.from(chunk));
      }
      const bytes = Buffer.concat(chunks);
      check(length === pin.size && sha256(bytes) === pin.sha256, "asset_download_digest");
      return bytes;
    }
    throw new RuntimeAssetError("asset_download_redirect");
  } catch (error) {
    // Native network errors can contain signed redirect URLs. Never surface them.
    throw error instanceof RuntimeAssetError ? error : new RuntimeAssetError("asset_download");
  }
}

export async function downloadRuntimeAsset(pin, { mirror, fetch: fetcher = globalThis.fetch,
  log = line => process.stderr.write(`${line}\n`) } = {}) {
  check(typeof mirror === "string" && /^https:\/\/github\.com\/Withso\/zeros\/releases\/download\/runtime-assets-[a-f0-9]{12}\/$/.test(mirror), "asset_mirror");
  let bytes;
  try { bytes = await downloadVerifiedAsset(`${mirror}${pin.sha256}`, pin, { fetch: fetcher }); }
  catch { /* Every unavailable or invalid mirror response falls back to the archive. */ }
  if (bytes) { log(`runtime_asset mirror ${pin.sha256}`); return bytes; }
  bytes = await downloadVerifiedAsset(pin.url, pin, { fetch: fetcher });
  log(`runtime_asset canonical ${pin.sha256}`); return bytes;
}
