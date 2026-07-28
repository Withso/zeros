# Auto-update hosting on Cloudflare R2 — setup & runbook (2026-07-22)

> **Update (2026-07-25) — SUPERSEDES the note below.** All three packaged channels
> auto-update from R2, but they carry **different payloads**: stable keeps its dmgs
> (rollback + the website Download button), while alpha/beta carry the **update payload
> only** (zip + blockmap + feed). electron-updater consumes the zip and never reads a
> dmg, so pre-release dmgs live on their GitHub prereleases instead — which is what
> keeps the bucket inside the free tier. The 2026-07-22 failure mode is now prevented
> *by construction*: a channel's `UPDATER_FEED_BY_CHANNEL` entry and its workflow's R2
> upload must move together, and `check:packaging-paths` fails on a half-change in
> either direction (it also rejects a pre-release dmg upload).
>
> **Historical (2026-07-22):** Beta briefly went GitHub-only (#198), which dropped
> its R2 mirroring and stranded every installed beta on a stale feed — the app
> kept polling `dl.zeros.build/beta/beta-mac.yml`, which no longer advanced, so
> it saw a version older than its own and reported a false "You're up to date!".
> Reverted at the time by mirroring beta to R2 again.

## Why this exists

`acme/zeros` is a **private** repo. GitHub serves private release assets only
to authenticated clients, so the installed app's auto-updater (anonymous) got
HTTP 404 on `latest-mac.yml` and every check failed with "Couldn't check for
updates" — for **every** user, on **every** version. The website Download
button pointed at the same private URL and was equally broken.

The fix ("Option D"): keep GitHub Releases as the private, complete archive,
and serve the update feed + artifacts publicly from **Cloudflare R2** behind
the custom domain **`dl.zeros.build`**. R2 has $0 egress (the ~173 MB zips
cost nothing to serve at any volume), and a 60s edge-cache TTL on the tiny
feed file makes the app fleet's 5-minute polling free regardless of user
count — cache hits are served by Cloudflare's edge and don't count as R2
Class B reads.

## Architecture

```
zeros-releases (R2 bucket)  →  https://dl.zeros.build
├── stable/
│   ├── latest-mac.yml                 ← feed; Cache-Control max-age=60
│   ├── Zeros-<X.Y.Z>-arm64-mac.zip    ← what the auto-updater downloads; immutable
│   ├── Zeros-<X.Y.Z>-arm64-mac.zip.blockmap ← differential-update index; immutable
│   ├── Zeros-<X.Y.Z>-arm64.dmg        ← rollback/manual-install copies; immutable
│   └── Zeros-arm64.dmg                ← constant name; the website Download button
├── alpha/                              ← PAYLOAD ONLY (no dmg)
│   ├── alpha-mac.yml                   ← feed; max-age=60
│   ├── Zeros-Alpha-<V>-arm64-mac.zip   ← what the updater downloads; immutable
│   └── Zeros-Alpha-<V>-arm64-mac.zip.blockmap
└── beta/                               ← PAYLOAD ONLY (no dmg)
    ├── beta-mac.yml                    ← feed; max-age=60
    ├── Zeros-Beta-<V>-arm64-mac.zip    ← immutable
    └── Zeros-Beta-<V>-arm64-mac.zip.blockmap
```

**Payload split (since 2026-07-25).** `stable/` carries the update payload *and* the
dmgs; `alpha/` and `beta/` carry the **payload only** — no dmg, because the updater
never reads one. First-time installs of Alpha/Beta come from their GitHub prereleases
(each keeps a constant-named `Zeros-{Alpha,Beta}-latest-arm64.dmg` permalink). Enforced
by `electron/updater.ts`'s `UPDATER_FEED_BY_CHANNEL` + `check:packaging-paths`.


Who reads what:

- **Stable app** — generic provider baked from `electron-builder.yml`'s
  `publish` block → `stable/latest-mac.yml`, then its zip and the blockmap URL
  derived from that zip name. Without the blockmap, updates remain correct but
  fall back to a full zip download.
- **Alpha / Beta apps** — runtime `setFeedURL` in `electron/updater.ts`
  (`UPDATER_FEED_BY_CHANNEL`) → `alpha/alpha-mac.yml` / `beta/beta-mac.yml`, then the
  zip named in that feed. Their **dmgs are not on R2** — first install comes from the
  GitHub prerelease.
- **Website** (`website/marketing/src/lib/site.ts`) →
  `stable/Zeros-arm64.dmg`.
- **CI** — `release.yml` uploads to `stable/` and prunes to the **last 10
  versions** (the just-published version is hard-guarded from deletion);
  `release-alpha.yml` / `release-beta.yml` upload the **payload only** to `alpha/` /
  `beta/` and prune to the newest **2** (one generation of overlap, so a client that
  started downloading just before a new build can't have its zip deleted mid-transfer).
  Feed files are always uploaded **last** so they never reference an
  incomplete zip/blockmap set. GitHub keeps every version, so anything pruned
  from R2 can be re-uploaded from the archive.

Retention math — **REMEASURED 2026-07-25.** The bundled Claude Code CLI is 262 MiB
raw but compresses to **82 MiB** (measured with `zip -6`, ratio 0.31), so it adds ~82 MB
to each artifact rather than the ~262 MB a naive estimate suggests. Current per-version
sizes: **zip ≈ 255 MB**, **dmg ≈ 257 MB**, blockmap ≈ 2 MB.

| Prefix | Contents | Retained | Size |
| --- | --- | --- | --- |
| `stable/` | zip + blockmap + versioned dmg + constant dmg | 10 | ≈ 5.3 GB |
| `alpha/` | zip + blockmap + feed | 2 | ≈ 0.5 GB |
| `beta/` | zip + blockmap + feed | 2 | ≈ 0.5 GB |
| | | **total** | **≈ 6.3 GB** |

Inside the 10 GB free tier, so storage, egress, reads and writes all stay at **$0**.

Two levers if it ever gets tight: drop alpha/beta to `KEEP=1` (−0.5 GB, at the cost of
the mid-download overlap), or trim stable's retention (each version back is ~515 MB of
rollback history). Adding pre-release dmgs back would cost ~257 MB per retained version
per channel for files nothing fetches — `check:packaging-paths` rejects it.

`KEEP` lives in each workflow's prune step. GitHub Releases retain **every** version,
so anything pruned from R2 can be re-uploaded from the archive.

### The `?static=1` query param is load-bearing

electron-updater's generic provider appends a fresh `?noCache=<timestamp>` to
every feed request **unless the base URL already carries a query string**
(`newUrlFromBase` in electron-updater). A unique query per poll would give
every poll a distinct Cloudflare cache key → guaranteed cache miss → one
billable R2 read per poll per user, defeating the entire caching design. The
constant `?static=1` on the publish/feed URLs (`electron-builder.yml`,
`scripts/electron-builder-run.mjs`, `electron/updater.ts`) pins one cache key
so the 60s edge TTL absorbs all polling. Do not remove it.

## One-time Cloudflare setup (dashboard)

1. **Create the bucket** — dash.cloudflare.com → R2 → Create bucket →
   name `zeros-releases`, location Automatic.
2. **Attach the custom domain** — bucket → Settings → Public access →
   Custom Domains → Connect Domain → `dl.zeros.build` (the `zeros.build` zone
   is already on this Cloudflare account, so this is one click; it also
   enables edge caching — do **not** use the `r2.dev` URL, it's rate-limited
   and uncached).
3. **Cache rule so the feed's TTL is honored** — `.yml` is not in
   Cloudflare's default-cached file extensions, so without this every poll
   would pass through to R2. Zone `zeros.build` → Caching → Cache Rules →
   Create rule:
   - **If**: Hostname equals `dl.zeros.build`
   - **Then**: Eligible for cache; Edge TTL → **Respect origin TTL**;
     Browser TTL → Respect origin.
     The workflows set `Cache-Control` per object (60s feeds, 1-year immutable
     artifacts), so this one rule is all the edge needs.
4. **Create an R2 API token** — R2 → Manage R2 API Tokens → Create API token →
   permission **Object Read & Write**, scoped to **only** the
   `zeros-releases` bucket. Copy the Access Key ID + Secret Access Key.
5. **Add the GitHub Actions secrets** (repo → Settings → Secrets → Actions):
   - `R2_ACCOUNT_ID` — the Cloudflare account ID (dash sidebar).
   - `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` — from step 4.

## Rollout order (matters!)

All three release workflows **fail loudly** if the R2 secrets are missing — a merge to
main would fail its Alpha release job. Do it in this order:

1. Cloudflare steps 1–5 above.
2. **Backfill the current release** so the website button and feed work
   immediately (from a machine with `gh` + repo access):

   ```bash
   gh release download v0.0.9 --repo acme/zeros -D /tmp/zeros-v0.0.9
   cd /tmp/zeros-v0.0.9
   export AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… AWS_DEFAULT_REGION=auto
   export AWS_REQUEST_CHECKSUM_CALCULATION=when_required
   EP=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
   aws s3 cp Zeros-0.0.9-arm64-mac.zip s3://zeros-releases/stable/Zeros-0.0.9-arm64-mac.zip \
     --endpoint-url $EP --cache-control "public, max-age=31536000, immutable" --content-type application/zip
   # Releases produced after the blockmap guard include this file. Older releases
   # safely fall back to the full zip.
   if [ -f Zeros-0.0.9-arm64-mac.zip.blockmap ]; then
     aws s3 cp Zeros-0.0.9-arm64-mac.zip.blockmap s3://zeros-releases/stable/Zeros-0.0.9-arm64-mac.zip.blockmap \
       --endpoint-url $EP --cache-control "public, max-age=31536000, immutable" --content-type application/octet-stream
   fi
   aws s3 cp Zeros-0.0.9-arm64.dmg s3://zeros-releases/stable/Zeros-0.0.9-arm64.dmg \
     --endpoint-url $EP --cache-control "public, max-age=31536000, immutable" --content-type application/x-apple-diskimage
   aws s3 cp Zeros-arm64.dmg s3://zeros-releases/stable/Zeros-arm64.dmg \
     --endpoint-url $EP --cache-control "public, max-age=300" --content-type application/x-apple-diskimage
   aws s3 cp latest-mac.yml s3://zeros-releases/stable/latest-mac.yml \
     --endpoint-url $EP --cache-control "public, max-age=60" --content-type text/yaml
   ```

3. Merge this change. The push to `main` fires `release-beta.yml`, which
   publishes the first R2-served beta — a live end-to-end test.
4. Run `release.yml` to ship the first R2-served stable (e.g. v0.0.10).

## Verify

```bash
curl -sI https://dl.zeros.build/stable/latest-mac.yml   # 200, cache-control: public, max-age=60
curl -sI https://dl.zeros.build/stable/latest-mac.yml   # again → cf-cache-status: HIT
curl -sI https://dl.zeros.build/stable/Zeros-0.0.X-arm64-mac.zip.blockmap # 200
curl -sI https://dl.zeros.build/stable/Zeros-arm64.dmg  # 200
head -3 <(curl -s https://dl.zeros.build/stable/latest-mac.yml)  # version: 0.0.X
```

In the app: Zeros menu → Check for Updates should now report a result instead
of "Couldn't check for updates".

## Caveat: installs from v0.0.9 and earlier

Builds shipped before this change have the **github.com** feed URLs baked in,
and those have been dead (404) since the repo went private — they cannot
auto-update to anything. Every existing user needs **one** manual reinstall
(download the DMG from the website or the GitHub release page and drag to
/Applications). From the first R2-served build onward, auto-update works
normally, and updaters always jump straight to the latest version — pruned
intermediate versions on R2 are never needed.

## Security notes

- The R2 token is a **push-malicious-update key** in the wrong hands — it's
  scoped to the one bucket, lives only in GitHub Actions secrets, and Squirrel
  verifies the Developer ID signature on every update, so a forged feed still
  can't ship a runnable unsigned build.
- Stable still has `allowDowngrade = true` (needed for the 0.1.x → 0.0.x
  version reset — see `electron/updater.ts`). Once no one is on a pre-reset
  build, flip it to `false` so a rewritten feed can't roll users back to an
  older signed build.
