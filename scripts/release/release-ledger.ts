import { z } from "zod";
import { PromotionError, SHA, requireCheck, type Channel } from "./contracts";
import { poll } from "./io";

// The control plane forces an upgrade 30 days after a version's next release and
// treats versions older than the ledger as unsupported, so the ledger must cover
// that whole window. Readers mirror these bounds (release-ledger-limits.test.ts).
export const LEDGER_RETENTION_DAYS = 30;
export const MAX_LEDGER_RELEASES = 2000;
export const MAX_LEDGER_BYTES = 512 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

const ReleaseEntry = z.object({ version: z.string(), publishedAt: z.string().datetime(), sourceSha: z.string().regex(SHA) }).strict();
export const ReleaseLedger = z.object({ version: z.literal(1), channel: z.enum(["alpha", "beta", "production"]),
  releases: z.array(ReleaseEntry).max(MAX_LEDGER_RELEASES) }).strict();
export type Ledger = z.infer<typeof ReleaseLedger>;
export type LedgerEntry = z.infer<typeof ReleaseEntry>;

export function releaseLedgerAsset(channel: Channel): string {
  return channel === "production" ? "release-ledger.json" : `${channel}-release-ledger.json`;
}

export function releaseLedgerUrl(repository: string, channel: Channel): string {
  requireCheck(/^[\w.-]+\/[\w.-]+$/.test(repository), "Release ledger repository is invalid");
  return `https://github.com/${repository}/releases/${channel === "production" ? "latest/download" : `download/${channel}`}/${releaseLedgerAsset(channel)}`;
}

function versionParts(channel: Channel, version: string): bigint[] {
  const pattern = channel === "production" ? /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
    : new RegExp(`^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)-${channel}\\.(0|[1-9]\\d*)$`);
  const match = pattern.exec(version);
  requireCheck(match, "Release ledger version does not belong to its channel");
  return match.slice(1).map(part => BigInt(part));
}

export function buildReleaseLedger(channel: Channel, previous: unknown | null, entry: LedgerEntry): Ledger {
  const candidate = ReleaseEntry.safeParse(entry);
  requireCheck(candidate.success, "Release ledger entry is invalid");
  const parts = versionParts(channel, candidate.data.version);
  const parsed = previous === null ? null : ReleaseLedger.safeParse(previous);
  requireCheck(parsed === null || parsed.success && parsed.data.channel === channel, "Previous release ledger is invalid or belongs to another channel");
  const releases = parsed?.success ? parsed.data.releases.map(release => ({ ...release })) : [];
  const seen = new Set<string>();
  for (const release of releases) {
    versionParts(channel, release.version);
    requireCheck(!seen.has(release.version), "Previous release ledger contains duplicate versions");
    seen.add(release.version);
  }
  releases.sort((left, right) => Date.parse(left.publishedAt) - Date.parse(right.publishedAt));
  const existing = releases.find(release => release.version === candidate.data.version);
  if (existing) {
    requireCheck(existing === releases.at(-1) && existing.sourceSha === candidate.data.sourceSha, "A historical or different-source release version cannot be overwritten");
  } else {
    const latest = releases.at(-1);
    if (latest) {
      const priorParts = versionParts(channel, latest.version);
      const difference = parts.findIndex((part, index) => part !== priorParts[index]);
      requireCheck(difference >= 0 && parts[difference] > priorParts[difference], "Release ledger versions must advance monotonically");
      requireCheck(Date.parse(candidate.data.publishedAt) >= Date.parse(latest.publishedAt), "Release ledger publication time cannot move backwards");
    }
    releases.push(candidate.data);
  }
  return { version: 1, channel, releases: retainSupportWindow(releases, Date.parse(candidate.data.publishedAt)) };
}

/** A version stays supported until 30 days after its next release, so the newest
 * release before the window is kept too: it is still supported while its successor
 * is inside the window. */
function retainSupportWindow(releases: LedgerEntry[], now: number): LedgerEntry[] {
  const cutoff = now - LEDGER_RETENTION_DAYS * DAY_MS;
  const inside = releases.findIndex(release => Date.parse(release.publishedAt) >= cutoff);
  const first = inside < 0 ? releases.length - 1 : Math.max(0, inside - 1);
  return releases.slice(first).slice(-MAX_LEDGER_RELEASES);
}

async function readJson(response: Response): Promise<unknown> {
  requireCheck(response.ok, "Release ledger could not be read; refusing to discard publication history");
  const text = await response.text();
  requireCheck(Buffer.byteLength(text) <= MAX_LEDGER_BYTES, "Release ledger exceeds its size bound");
  try { return JSON.parse(text); }
  catch { throw new PromotionError("Release ledger JSON is invalid; refusing to discard publication history"); }
}

export async function previousReleaseLedger(repository: string, channel: Channel, token: string | undefined, fetcher: typeof fetch = fetch): Promise<unknown | null> {
  releaseLedgerUrl(repository, channel);
  const endpoint = channel === "production" ? "latest" : `tags/${channel}`;
  const response = await fetcher(`https://api.github.com/repos/${repository}/releases/${endpoint}`, {
    headers: { accept: "application/vnd.github+json", ...(token ? { authorization: `Bearer ${token}` } : {}), "X-GitHub-Api-Version": "2022-11-28" },
    redirect: "error", signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) return null;
  const release = await readJson(response) as { tag_name?: unknown; draft?: unknown; prerelease?: unknown; assets?: Array<{ name?: unknown; browser_download_url?: unknown }> } | null;
  requireCheck(release && release.draft === false && release.prerelease === (channel !== "production") && Array.isArray(release.assets) &&
    (channel === "production" ? /^v\d+\.\d+\.\d+$/.test(String(release.tag_name)) : release.tag_name === channel), "Previous channel feed release is invalid");
  const assets = release.assets.filter(asset => asset.name === releaseLedgerAsset(channel));
  requireCheck(assets.length <= 1, "Previous channel feed contains duplicate release ledgers");
  if (!assets.length) return null;
  const url = `https://github.com/${repository}/releases/download/${encodeURIComponent(String(release.tag_name))}/${releaseLedgerAsset(channel)}`;
  requireCheck(assets[0].browser_download_url === url, "Previous release ledger download is not the channel feed asset");
  return readJson(await fetcher(url, { headers: { accept: "application/json", "cache-control": "no-cache" }, redirect: "follow", signal: AbortSignal.timeout(30_000) }));
}

export async function verifyPublishedReleaseLedger(repository: string, expected: Ledger, options: { fetch?: typeof fetch; sleep?: (milliseconds: number) => Promise<void>; attempts?: number } = {}): Promise<void> {
  const fetcher = options.fetch ?? fetch, url = releaseLedgerUrl(repository, expected.channel);
  await poll(async () => {
    try {
      const response = await fetcher(`${url}?zeros-ledger=${Date.now()}`, { headers: { accept: "application/json", "cache-control": "no-cache" },
        redirect: "follow", signal: AbortSignal.timeout(30_000) });
      const parsed = ReleaseLedger.safeParse(await readJson(response));
      return parsed.success && JSON.stringify(parsed.data) === JSON.stringify(expected) ? true : false;
    } catch { return false; }
  }, { attempts: options.attempts ?? 30, timeoutMs: 5 * 60_000, sleep: options.sleep });
}
