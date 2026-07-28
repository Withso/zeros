# Release channels: Alpha → Beta → Production

**Landed:** 2026-07-25. Supersedes the two-channel (Beta-off-main → Production) model.

## Why this changed

Before this, every merge to `main` built **Beta**, and Production was a manual
`workflow_dispatch` that **rebuilt `main` HEAD at dispatch time**. Two consequences:

1. **The bytes tested in Beta were never the bytes shipped.** Production was an
   independent build of a moving target, so anything merged after the Beta you
   validated shipped untested.
2. **There was no stabilization point anywhere in the system** — nowhere to freeze a
   candidate, feature-test it, and land only fixes.

There was also no gate: `release-beta.yml` ran **no** tests, **no** typecheck, **no**
lint, and **no** signature verification. Neither release workflow typechecked at all
(`vite` + `tsup` strip types via esbuild without checking them).

## The model

```
main ─────────────────► Alpha    release-alpha.yml   auto on every merge · disposable
  └─ cut release/X.Y.Z ► Beta     release-beta.yml    auto on push to release/** · FROZEN
       └─ dispatch ────► Prod     release.yml         manual, on that SAME branch → tags vX.Y.Z
            └─ merge release/X.Y.Z back into main
```

| | Alpha | Beta | Production |
|---|---|---|---|
| Built from | `main`, every merge | `release/X.Y.Z`, every push | the same `release/X.Y.Z` |
| Version | `X.Y.Z-alpha.<run>` | `X.Y.Z-beta.<run>` | `X.Y.Z` |
| Trigger | automatic | automatic | manual dispatch |
| appId | `com.zeros.alpha` | `com.zeros.beta` | `com.zeros` |
| Signed | yes | yes | yes |
| Notarized | no | no | **yes** + stapled |
| First install | GitHub prerelease dmg | GitHub prerelease dmg | R2 / website dmg |
| Auto-update | **yes** (R2 payload) | **yes** (R2 payload) | **yes** |
| Retention | GitHub 3 · R2 2 | GitHub 3 · R2 2 | R2 10 |
| Purpose | dogfood main; safe to break | stabilize + feature-test | ship |

**Version bases are read from the branch name, not inferred from tags.** Cutting
`release/0.0.6` *is* the decision that this is 0.0.6, so Beta and Production off that
branch always agree. (`compute-version.mjs` infers "next patch after the highest tag",
which drifts: cut `release/0.0.7` before `v0.0.6` is tagged and it still says 0.0.6.)
`main` keeps the tag-derived fallback for hotfix dispatches.

## Per-channel isolation

All four flavors run simultaneously without interference. Every axis is keyed on
`channel()` (`src/engine/runtime.ts`):

| | dev | alpha | beta | stable |
|---|---|---|---|---|
| Data dir | `com.zeros.dev[.slug]` | `com.zeros.alpha` | `com.zeros.beta` | `com.zeros` |
| Dot-dir | `~/.zeros-dev` | `~/.zeros-alpha` | `~/.zeros-beta` | `~/.zeros` |
| Workspaces | `~/zeros-dev[-slug]/workspaces` | `~/zeros-alpha/workspaces` | `~/zeros-beta/workspaces` | `~/zeros/workspaces` |
| Engine ports | 24293+ | **24213–24222** | 24203–24212 | 24193–24202 |
| Deep link | `zeros-dev://` | `zeros-alpha://` | `zeros-beta://` | `zeros://` |
| Keychain | `Zeros Dev Safe Storage` | `Zeros Alpha Safe Storage` | `Zeros Beta Safe Storage` | `Zeros Safe Storage` |

Two fixes landed with this that the dot-dir column depends on:

- **The `~/.zeros` family is now split three ways.** Four call sites used to inline
  `isDevRuntime() ? ".zeros-dev" : ".zeros"` — a *two*-way split — so **Beta shared
  Production's `~/.zeros`**. That meant one `settings.toml` for both apps, a shared
  `state.db`/`worktrees/`, and a shared **`detach.lock`** — which is single-instance
  enforcement, so with Beta holding it Production could not enter detach mode at all
  (`DETACH_LOCKED`, naming a workspace it couldn't see). One helper now owns the leaf
  name: `zerosDotDirName()` in `src/engine/db/paths.ts`.
- **`channel()` now throws on an unrecognized `ZEROS_CHANNEL`** instead of silently
  resolving to `stable`. With three packaged channels, one typo would have pointed a
  build at Production's data dir, ports, feed and `zeros://` scheme.

Existing Beta users don't lose config: `seedUserSettingsFromLegacyRoot()`
(`src/engine/settings/files.ts`) does a one-time, non-destructive copy of
`settings.toml` + `settings.managed.toml` from the pre-split `~/.zeros`. It
deliberately copies **nothing else** — `state.db`, `worktrees/` and `detach.lock`
reference the other channel's workspaces and a live pid lock.

## Runbook

### Ship a release

```bash
# 1. Cut the stabilization branch from a green main.
git checkout main && git pull
git checkout -b release/0.0.6 && git push -u origin release/0.0.6
#    → release-beta.yml builds Zeros Beta 0.0.6-beta.<run> automatically. An
#      already-installed Beta auto-updates itself; a first install comes from the
#      rolling "beta" GitHub prerelease.

# 2. Test Beta. Land ONLY fixes on the branch (cherry-pick from main).
git cherry-pick <sha> && git push        # each push rebuilds Beta

# 3. Promote. Actions ▸ "Release (production)" ▸ Run workflow ▸ Branch: release/0.0.6
#    → builds THAT commit, notarizes, tags v0.0.6, publishes.

# 4. Merge the branch back so the fixes reach main.
git checkout main && git merge --no-ff release/0.0.6 && git push
```

### Promote a feature flag

`src/zeros/flags.ts` → `FEATURE_CHANNELS`:

```ts
"new-onboarding": ["dev", "alpha"],                    // dogfood on main
"new-onboarding": ["dev", "alpha", "beta"],            // into the release cut
"new-onboarding": ["dev", "alpha", "beta", "stable"],  // ship
```

Unregistered features are OFF everywhere — a typo can never ship to Production.

### Add a channel

`CHANNELS` in `src/engine/runtime.ts` is the single source of truth. Add the value,
then the compiler / guards will point at every map that needs completing:
`engineBasePort`, `schemeForChannel`, `CHANNEL_DISPLAY_NAME` (`electron/main.ts`),
`UPDATER_FEED_BY_CHANNEL` (`electron/updater.ts`), `ENGINE_PORT_BY_CHANNEL`
(`ws-client.ts`), `OVERRIDES` (`electron-builder-run.mjs`), `CHANNEL_PLIST`
(`electron-after-pack.cjs`), `CHANNELS` (`src/zeros/flags.ts`), and
`CHANNEL_WORKFLOWS` (`check-vite-env-sync.mjs`). Data dirs, workspaces roots, dot-dir
and keychain name derive automatically.

## Gates (all three release paths)

| Gate | preflight | alpha | beta | stable |
|---|---|---|---|---|
| typecheck | ✅ | ✅ **new** | ✅ **new** | ✅ **new** |
| lint | ✅ | ✅ **new** | ✅ **new** | ✅ **new** |
| `test:git` | ✅ | ✅ **new** | ✅ **new** | ✅ |
| 6 ship guards | ✅ | ✅ **new** | ✅ **new** | ✅ |
| `smoke:engine` | ✅ | ✅ | ✅ | ✅ |
| `smoke:packaged-pty` | — | ✅ | ✅ | ✅ |
| signature + hardened runtime | — | ✅ **new** | ✅ **new** | ✅ |
| notarize + staple + Gatekeeper | — | — | — | ✅ |

Gates run as **steps inside the build job**, not a separate `needs:` job — a separate
job would re-checkout and re-install (~1–2 min) to duplicate work already done. They
sit before `build:sidecar`, so a failure costs seconds instead of a full pack.

Signature verification on alpha/beta deliberately stops short of `stapler validate` /
`spctl -t exec`: both channels are signed but **not** notarized by design, so those
would fail on a correct build. Everything up to notarization is asserted — which
matters because electron-updater's macOS in-place update *requires* a valid matching
signature, so a silently-unsigned build would publish fine and only surface later as
"auto-update is broken".

## Manual setup still required

1. ~~`build/icons/icon-alpha.icns`~~ — **done.** An α-badged mark now ships, matching
   the β badge's circle geometry, `#C17400` fill and stroke weight.
   `check:packaging-paths` asserts each channel has its own distinct icon file.
2. **R2** — nothing to provision (S3 prefixes are implicit); the first Alpha publish
   creates `alpha/`. After the first run, confirm
   `dl.zeros.build/alpha/alpha-mac.yml` resolves and lists the **zip** (not a dmg).
3. **Branch protection** — protect `release/**` so only cherry-picks land there.
4. **Existing Beta installs keep auto-updating** — they poll `dl.zeros.build/beta`,
   which the release-branch Beta still publishes to. The only change they'll notice is
   that new Betas appear when a `release/*` branch is active rather than on every
   merge. Anyone who wants to track main should install **Alpha**.

## What this does NOT fix

Alpha is a **post-merge** signal: it catches the bug, but the commit is already in
main and you cannot iterate pre-merge. It does not replace a prod-shape local lane —
see `.context/dev-vs-beta-vs-prod-divergence-audit.md` §11 for the fidelity/cost
ladder (`--dir` pack ≈ "Beta minus notarization", and **only with `CSC_LINK` set**,
since an ad-hoc signature makes `hardenedRuntime` inert).

Still open from that audit: `usePolling: !isDevRuntime()` (dev uses FSEvents, every
packaged channel uses 1.5 s polling), the vitest-vs-shipping SQLite driver split, the
engine respawn loop's missing give-up, and updater error classification/backoff.

---

## Addendum (2026-07-25): what R2 carries per channel

All three packaged channels **auto-update**. They carry different payloads:

| Prefix | zip + blockmap + feed | dmg | Retained |
| --- | --- | --- | --- |
| `stable/` | ✅ | ✅ versioned + constant-named | 10 |
| `alpha/` | ✅ | ❌ | 2 |
| `beta/` | ✅ | ❌ | 2 |

**Why no pre-release dmg on R2.** electron-updater consumes the **zip**; the dmg is
only ever used for a first-time *manual* install. Alpha/Beta get theirs from the GitHub
prerelease, which keeps a constant-named `Zeros-{Alpha,Beta}-latest-arm64.dmg`
permalink. Keeping dmgs off R2 for pre-release channels is what fits the bucket in the
free tier: ~257 MB per retained version per channel, for a file nothing fetches.
`check:packaging-paths` rejects a pre-release dmg upload.

**The sizing, measured rather than guessed.** The Claude Code CLI is 262 MiB raw but
compresses to **82 MiB** (`zip -6`, ratio 0.31) — so it adds ~82 MB per artifact, not
~262 MB. An earlier estimate in this repo assumed poor compression and put the bucket at
~13 GB, which prompted a plan to drop alpha/beta from R2 entirely. The real total is
**≈6.3 GB** (stable 5.3 + alpha 0.5 + beta 0.5), comfortably inside the 10 GB tier, so
auto-update is kept on every channel.

**`KEEP=2` for pre-release, not 1.** The updater only needs the version named in the
feed, but one generation of overlap means a client that started downloading just before
a new build can't have its zip deleted mid-transfer. ~255 MB of insurance per channel.

**Both halves or neither.** A channel's `UPDATER_FEED_BY_CHANNEL` entry
(`electron/updater.ts`) and its workflow's R2 upload step must move together. #198 broke
by removing beta's uploads while the app kept polling — stale feed, false "You're up to
date!". The reverse leaves objects nobody reads. `check:packaging-paths` fails on a
half-change in either direction, and `electron/__tests__/updater-channel-feeds.test.ts`
pins the source side.
