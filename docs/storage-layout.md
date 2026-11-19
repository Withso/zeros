# Storage layout

Where Zeros keeps data on a device, which of it is regenerable, and how
development identities are registered and cleaned up. Code is authoritative:
every root comes from `apps/desktop/src/engine/db/paths.ts`, and the
development family's shapes from
`apps/desktop/src/engine/db/local-development-paths.cjs`, which the plain-Node
launchers, the prune and `pnpm storage:sweep` import too. Nothing else builds
`Library/…`, `.zeros*` or `zeros*` paths by hand.

## Roots

| Root | Resolver | Holds |
| --- | --- | --- |
| Data dir | `zerosDataDir()` | `zeros.db`, `secrets.json`, `app-settings.json`, `engines/`, `worktrees/`, `sessions/`; Electron's `userData` |
| Shared data dir | `zerosChannelDataDir()` | An installed channel's data dir; the development family's `com.zeros.local` (shared Local provider credentials, instance registry) |
| State root | `zerosStateRoot()` | `settings.toml`, `term-zdotdir/`, `state.db`, `detach.lock`, `default-project/` |
| Visible root | `zerosVisibleRoot()` | `workspaces/`, `design workspaces/`, `cloud-sync/` |
| Session data | `zerosSessionDataDir()`; `zerosEffectiveSessionDataDir()` for this launch | Electron `sessionData`, the whole Chromium profile, caches included: `<data dir>/electron` once moved (see [Renderer session data](#renderer-session-data)) |
| Cache dir | `zerosCacheDir()` | The old session location (`Caches/<id>`); nothing new is written there |
| Log dir | `zerosLogDir()` | `main.log`, `app.jsonl`, `engine.log` |
| Bundle dir | `zerosDevelopmentBundleDir()` | Development only: the native `.app` clone and its `.version` marker |

The storage family is a storage decision only: `storageFamily()` is
`development` for the `dev` channel and `installed` otherwise. Account-free
admission stays `isLocalDevelopmentRuntime()`, which Electron main decides.

## Installed channels

Stable is `com.zeros`, Alpha is `com.zeros.alpha`. One app per channel.

| Kind | macOS | Linux | Windows |
| --- | --- | --- | --- |
| Data | `~/Library/Application Support/<id>/` | `$XDG_DATA_HOME` or `~/.local/share` + `zeros[-alpha]/` | `%APPDATA%/<id>/` |
| State root | `~/.zeros[-alpha]/` | same | same |
| Visible root | `~/zeros[-alpha]/` | same | same |
| Session data | `~/Library/Application Support/<id>/electron/` | `<data>/electron/` | The data dir itself, unchanged |
| Old session location | `~/Library/Caches/<id>/` | `~/.cache/<id>/` | — |
| Logs | `~/Library/Logs/<id>/` | `<data>/logs/` | `<data>/logs/` |

## Development family

`pnpm electron:local`, `pnpm electron:alpha` and the identities test scripts
mint. One folder per kind; each instance is a subfolder named by its id.

| Kind | macOS path |
| --- | --- |
| State root | `~/.zeros-local/instances/<inst>/` |
| Visible root | `~/zeros-local/<inst>/{workspaces,design workspaces,cloud-sync}` |
| App data | `~/Library/Application Support/com.zeros.local/instances/<inst>/` |
| Shared Local provider credentials | `~/Library/Application Support/com.zeros.local/` |
| Instance registry | `~/Library/Application Support/com.zeros.local/instances.json` |
| Session data | `~/Library/Application Support/com.zeros.local/instances/<inst>/electron/` |
| Old session location (builds of the storage branch before the move; nothing writes there now) | `~/Library/Caches/com.zeros.local/instances/<inst>/` |
| Native bundle + version marker | `~/Library/Caches/com.zeros.local/bundles/<inst>/` |
| Logs | `~/Library/Logs/com.zeros.local/<inst>/` |
| Preferences (written by macOS) | `~/Library/Preferences/com.zeros.local.<inst>.plist` |
| Other folders macOS names for the bundle id | `~/Library/{HTTPStorages,WebKit}/com.zeros.local.<inst>/`, `~/Library/Saved Application State/com.zeros.local.<inst>.savedState/` |

Linux uses `$XDG_DATA_HOME` or `~/.local/share` + `zeros-local/instances/<inst>`
with logs beside the data; Windows uses `%APPDATA%/com.zeros.local/instances/<inst>`.
The macOS bundle id is `com.zeros.local.<inst>`.

### Instance ids

- A Local checkout: the first 16 hex characters of the SHA-256 of the
  canonical checkout path.
- `alpha`: `pnpm electron:alpha`, one profile for every checkout. It is the
  `dev` channel with hosted sign-in against Alpha, the dev ports and
  `zeros-dev://`, never account-free. App name `Zeros Local` (keychain item
  `Zeros Local Safe Storage`); window and Dock name `Zeros Local Alpha`. A
  second concurrent launch fails before building or refreshing auth, through
  its lease (`~/.zeros-local/instances/alpha/launcher.lease`), its running
  app's `SingletonLock`, and the checkout's `.context/zeros-local/launcher.lock`
  that `electron:local` from the same checkout also takes. Moving off the retired
  `com.zeros.dev` profile (keychain `Zeros Dev Safe Storage`) means signing in
  to Alpha once again; the old account store is not migrated.
- `default`: a dev-channel process with no instance (a bare run, unit tests).
- `<purpose>-<random>`: an ephemeral identity a test or qualification script
  mints through `scripts/ephemeral-local-identity.mjs`.

`alpha` and `default` are reserved; main refuses account-free admission on
either.

### Secret stores

`apps/desktop/electron/storage-identity.ts` decides `ZEROS_SHARED_SECRETS_DIR`;
an inherited value never survives.

| Identity | secrets.json |
| --- | --- |
| Local checkout | Shared `com.zeros.local/secrets.json` |
| Local with `ZEROS_ISOLATE=1` | Its own instance data dir |
| `alpha` | Its own instance data dir (`instances/alpha/`) |
| Other hosted dev identity | `alpha`'s store, so it reuses that sign-in |
| Hosted dev with `ZEROS_ISOLATE=1` | Its own instance data dir |
| Stable, Alpha | The channel's data dir |

Account-free Local never reads `alpha`'s account store, and `alpha` never
reads or writes Local's shared provider store.

Claude and Codex account profiles live in `provider-accounts/<provider>/<uuid>`
beside the `secrets.json` that records them, and keep their original path
because the providers namespace Keychain entries by it. An identity that kept a
store of its own (before shared Local credentials, or with `ZEROS_ISOLATE=1`)
has profiles inside its data dir; once a shared launch migrates its records,
the shared store points there and writes the plaintext marker
`local-provider-migration:<sha256(<data dir>/secrets.json)>`. Prune and sweep
keep such a data dir (see below).

## Renderer session data

Electron's `sessionData` is the whole Chromium profile: durable renderer state
(`Local Storage`, `IndexedDB`, `Cookies`, `Session Storage`, `Partitions/`, …)
and the caches Chromium keeps beside it (`Cache`, `Code Cache`, `GPUCache`, the
Dawn caches, …). It lives in `<data dir>/electron/`, as one unit, for
installed channels and consolidated development identities; no cache is split
off (`session.setCodeCachePath` is not used: it reinitializes the code-cache
backend every launch). `--disk-cache-size` caps the HTTP cache at 250 MB.

- **Windows** keeps its old location, which already is the data dir
  (Electron's cache path there is Roaming AppData).
- **A legacy-layout Local profile** keeps its session in
  `Caches/com.zeros.local.<inst>/`; it never moves.
- **`ZEROS_DATA_DIR`** always wins: `<ZEROS_DATA_DIR>/electron/`, for every
  family and layout, and nothing is ever imported into an override.

`REGENERABLE_SESSION_ENTRIES` in `apps/desktop/src/engine/db/session-entries.ts`
names the entries Chromium rebuilds (observed on Electron 43 / Chromium 150);
every other name, unknown ones included, is durable. Classification reads that
list per entry; no whole directory is ever described as clearable. The profile
itself is found through `zerosEffectiveSessionDataDir()`
(`effectiveSessionDataDir()` for the plain-Node scripts): the moved location
once its marker is there, otherwise the old one.

### Moving existing profiles

Before `ready`, `apps/desktop/electron/session-location.ts` chooses this
launch's profile. Each identity has exactly one old profile: `Caches/<id>/`
(for consolidated development identities, `Caches/com.zeros.local/instances/<inst>/`);
for Stable only, the older `Caches/design.zeros.app/` when `Caches/com.zeros`
does not exist at all. Never both. The marker of the older hop
(`Caches/com.zeros/.zeros-session-migrated`) recorded an attempt, not a
complete copy, so when both exist `design.zeros.app` can still hold the only
copy of some old state: nothing merges it, and it stays on disk until a person
names it in `pnpm storage:sweep` once Stable's profile has moved.

1. `electron/.zeros-session-relocated` is a file → use `electron/`.
2. No old profile → create `electron/`, write the marker, use it.
3. Otherwise the whole old profile moves to `electron/` in one `rename(2)`, the
   marker is written, and `electron/` is used. The old profile is used instead,
   unchanged, for this launch, with one line in the durable `main.log`, when:
   another live process has the profile open (Chromium's `SingletonLock` in
   the data dir names a live pid other than this one, or cannot be read or
   parsed, or names another host); the old and new locations are on different
   volumes; any component of either path is a symlink; the old location is not
   a folder, or links one of its entries to a store elsewhere (a relative link
   would resolve differently after the move); `electron/` already holds
   something; or the two locations overlap.

A launch therefore always runs on one coherent profile, old or new. Nothing is
merged, copied, filled in, deleted or left half-moved, so there is no partial
state to recover. Two processes starting together: the second finds the old
profile gone and `electron/` in place and uses it. A missing marker after a
successful move only means the next launch writes it. A rename keeps every
inode, so a moved profile opens warm (verified on Electron 43.8.3: the
`localStorage` draft, cookies and HTTP cache reopen, with no asset refetch). A
334 MB, 3,752-file profile moved in 2.4 ms on the development VM; a marked
launch costs one `lstat`.

**Cross-volume.** A data dir on another volume than `~/Library/Caches` (a moved
home or a symlinked Application Support) keeps the old profile in place for
every launch. That is the previous behavior, never a copy.

**Downgrade.** A build from before this change reads renderer state from the
old location again and finds none: drafts, theme and permissions look reset in
that build, while the profile itself is intact in `electron/` and returns on
upgrade. The updater never installs an older build; a manual downgrade does.

## Stores that grow, and why nothing prunes them automatically

No installed app deletes anything from a profile automatically. Each store
below grows, and each would need an owner that can prove a removal safe; an
automatic deleter that can only guess is worse than the space it frees.

| Store | Why nothing prunes it |
| --- | --- |
| `engines/<repoKey>/` | Tiny runtime metadata: an `engine.json` manifest and a `busy` heartbeat per repository (1.9 MB on the owner's Mac). An entry can be re-used by an engine at any moment: a starting engine creates the directory before it publishes its manifest, and a host waits on that path, so no check by name can tell a stale entry from one being written. |
| `design-storage/` | Design recovery journals, review receipts, result bundles, retired private drafts, thumbnails and recording chunks, recorded against a hash of the workspace path. Thumbnails stay within their byte budgets through the thumbnail store's own sweep. `recording-chunks/` is unbounded until Design owns a sweep for unreferenced chunks. |
| `git-promotion-journal/` | Written by a retired build; no current code reads it, and its records may describe unfinished work. It has no Clear. |
| Updater staging: `Caches/zeros-updater/` and `Caches/<bundle id>.ShipIt/` (macOS) | Owned by electron-updater and Squirrel.Mac. Stable and Alpha share one download folder (app-builder-lib names it after `package.json` `name`, `zeros`, which both keep), so one channel cannot tell whether the other still needs a pending download or the differential base `update.zip`. A copy running a version is not proof that another copy of the same app was updated, and Squirrel writes its install request before it launches ShipIt. |

For ShipIt staging, the pinned Electron v43.8.3 carries Squirrel.Mac's own
cleanup (`patches/squirrel.mac/fix_clean_up_orphaned_staged_updates_before_downloading_new_update.patch`):
when a new update download starts, it removes the earlier `update.*` staging
directories, except the one that holds the staged bundle named in
`ShipItState.plist`. It does not run at launch or quit, and it does not touch
`Caches/zeros-updater/`.

The development family is never auto-updated. Its only deleters are developer
tools: the launcher's bundle prune, the ephemeral-identity helper and
`pnpm storage:sweep`.

Follow-up, not in this change: give Alpha its own updater cache
(`-c.extraMetadata.name=zeros-alpha` in `scripts/electron-builder-run.mjs`
gives `zeros-alpha-updater`). It also renames the packaged `package.json`
`name`, so it needs a real Alpha release build to verify. Residue already in
the shared folder would still have no provable owner.

## Registry

`instances.json` records every development identity a launcher started:

```json
{ "version": 1, "instances": { "<inst>": {
  "kind": "checkout" | "alpha" | "ephemeral",
  "name": "Zeros Local zeros d90b51", "checkout": "/abs/path or null",
  "layout": "v2" | "legacy", "createdAt": "ISO", "lastUsedAt": "ISO",
  "ownerPid": 1234 } } }
```

`ownerPid` is present only for ephemeral identities. The file is owner-only
(`0600`), rewritten atomically (temporary file and rename) under an exclusive
lock (`instances.json.lock`). A holder is recovered only on positive evidence
that it is gone: its pid is dead. A live pid keeps the lock however old it is;
an unreadable owner is retired after 30 seconds. Launchers wait at most 250 ms
for it and continue unregistered rather than delay a launch. Unknown
fields and instances survive a rewrite. A corrupt file is renamed aside to
`instances.json.corrupt-<time>` and rebuilt empty. Each launch upserts its own
entry and `lastUsedAt`, legacy-layout identities included
(`scripts/local-instance-registry.mjs`).

## Prune at launcher start

`scripts/local-instance-prune.mjs` removes only what is provably regenerable.
Both launchers start it after the app stack has been spawned; it is
asynchronous end to end, stops at a three-second budget, never throws and can
never delay or fail a launch. It never removes an identity's app data, state
root, visible root, session data or registry entry: durable removal is
`pnpm storage:sweep`, run by a person.

| Registered identity | Removed |
| --- | --- |
| `checkout` whose path is gone and `lastUsedAt` is over 14 days old | Its native bundle only (`Caches/com.zeros.local/bundles/<inst>/`; legacy `<state root>/bundle/`) |
| Any identity unused for 14 days whose bundle was built for another Electron | The bundle only |
| `ephemeral` (v2) whose owner is gone, with no work and no provider-store reference | Everything and then the entry; the entry stays if anything remains |

It skips the launching identity, a corrupt registry, and any identity that may
be in use: its lease (`<state root>/launcher.lease`, held by every launcher for
the lifetime of its app stack; the state root never moves, so a renamed or
unmounted checkout cannot hide it), the older `<state root>/launcher.lock`, the
checkout's `.context/zeros-local/launcher.lock`, the profile's `SingletonLock`,
or a live ephemeral owner. Anything unreadable counts as in use. An ephemeral
identity is checked again just before it is removed. Every target is
resolver-derived, sits directly inside its expected folder under `$HOME`, and
no symlink is followed, from `/` down to the target.

Every development deleter (this prune, the ephemeral-identity helper, bundle
preparation and the sweep) goes through
`apps/desktop/src/engine/db/contained-removal.cjs`. It refuses a `$HOME`
reached through any link before reading below it, then checks every component
from `$HOME` down. One window remains: Node has no handle-based (`openat` /
`unlinkat`) removal, so a target is validated by path and removed by path, and
a component another process swaps in between is not detected. These tools run
only when a person or the dev launcher starts them, never inside an installed
app.

## `pnpm storage:sweep`

`scripts/storage-sweep.mjs` removes residue of retired identities and of Local
identities the registry does not know. Node built-ins only, so it runs in a
checkout without `node_modules`. It is a dry run by default: it prints each
category, path, identity and allocated size (what `du` reports, each
hardlinked inode counted once), and a total.

```sh
pnpm storage:sweep                         # dry run
pnpm storage:sweep --apply                 # delete what the dry run lists as removable
pnpm storage:sweep --only beta,dev-desktop
pnpm storage:sweep --identity <id>,<id>    # only these identities, including ones that hold data
pnpm storage:sweep --keychain              # also Zeros Dev / Zeros Beta Safe Storage
```

| Category | Matches |
| --- | --- |
| `dev-desktop` | `com.zeros.dev`, `com.zeros.dev.*`, `Zeros Dev`, `Zeros — *`, `design.zeros.app.dev*` in Application Support, Caches, Logs, Preferences (`.plist`), HTTPStorages, WebKit and Saved Application State; `~/.zeros-dev/dev-instances`; `~/zeros-dev*` |
| `beta` | `com.zeros.beta*`, `design.zeros.beta*` in the same folders; `~/.zeros-beta`; `~/zeros-beta` |
| `legacy-scheme` | `design.zeros.app`, `design.zeros.oCanvas` in the same folders |
| `local-unregistered` | Local identities absent from the registry, in both layouts (including the `com.zeros.local.<inst>` entries in HTTPStorages, WebKit and Saved Application State, and a legacy `<state root>/bundle`), and `~/.zeros-local/dev-instances` |
| `local-orphaned` | Registered checkouts whose checkout path is gone |

A Dev identity's slug, display label (`Zeros — Coral Reef`) and folder suffix
name one identity (`coral-reef`); `dev` is the shared `com.zeros.dev` store.

Unknown is kept:

- **Without `--identity`** only bundles, and identities provably empty of user
  data, are removed. User data is a database or any other entry in a data,
  state or session folder that is not on the regenerable list, provider
  profiles, a visible root with workspace entries (anything beyond empty
  `workspaces`, `design workspaces` and `cloud-sync` folders), or anything
  under `<state root>/worktrees`, where the engine keeps archived, adopted and
  in-recovery worktrees. Such an identity lists "holds user data" or "has
  workspaces", and only its bundle is removable. Anything unreadable counts.
- **Reserved identities** (`alpha`, `default`) are kept unless named.
- **Not evidence of abandonment:** a missing or corrupt registry keeps every
  `local-unregistered` group; a folder that cannot be listed, or is reached
  through a symlink, keeps every group it could hide; an unavailable process
  list keeps everything. Each is shown as the reason.
- **In use** is kept even when named: a process command line naming a
  candidate, the identity's lease or launcher locks, or a profile's
  `SingletonLock`.
- **Provider profiles** a Local data dir holds stay, with its state, visible
  and session folders, while the shared provider store references it, or when
  that store is anything the app's reader would reject.
- **`legacy-scheme`:** `Caches/design.zeros.app` can be Stable's only renderer
  profile, so the category is kept, even when named, until Stable's profile has
  moved (`com.zeros/electron/.zeros-session-relocated` exists).
- **Dependencies:** while any Dev identity keeps data, the shared `com.zeros.dev`
  store, `Zeros Dev` and the `Zeros — *` label folders stay too.

`--apply` takes each identity's lease, plans that group again from fresh
evidence (registry, liveness, provider store, every work root) and removes only
what is still removable for the same reasons; anything that changed is kept
and reported. The state root goes last, since it holds the lease. Targets match
exact patterns and must be a real file or directory directly inside its
expected folder under a `$HOME` reached through no link; nothing below a
refused or linked folder is listed, sized or removed. The total after `--apply` counts only what was
removed, and is an upper bound when a removed file had another hardlink (a
bundle shares inodes with `node_modules`).

`--keychain` checks for the two Safe Storage items without reading them, and
offers one only for a category being swept. `--apply` deletes it only when no
file of that app remains, and nothing could be hidden, afterwards.

The sweep never touches `com.zeros` or `com.zeros.alpha` in any Library
folder, `~/.zeros`, `~/.zeros-alpha`, `~/zeros`, `~/zeros-alpha`, `~/.zeros-dev`
other than `dev-instances`, or the files of the shared `com.zeros.local/`
folder.

## Compatibility contracts

- **Legacy Local layout.** Local profiles created before the registry live at
  `com.zeros.local.<inst>` (Application Support, Caches, Logs),
  `~/.zeros-local/instances/<inst>/bundle/` and `~/zeros-local-<inst>/`. Their
  databases and Keychain-bound provider profiles hold absolute paths, so they
  are not moved.
- **`ZEROS_LOCAL_LAYOUT=legacy`.** `pnpm electron:local` decides once per
  launch: when the legacy data dir for its identity exists it exports
  `ZEROS_LOCAL_LAYOUT=legacy`, and every root for that identity resolves exactly
  as before. Nothing else selects the legacy shape; it is ignored for `alpha`,
  `default` and installed channels. The engine strips it from terminals,
  provider shells, Git, MCP servers and tools, like `ZEROS_LOCAL_DEVELOPMENT`.
- **Overrides.** `ZEROS_DATA_DIR` replaces the data dir (and the shared data
  dir) for every channel; `ZEROS_WORKSPACES_DIR` replaces the workspaces root and
  makes its parent the visible root; `ZEROS_DESIGN_WORKSPACES_DIR` replaces the
  design workspaces root. The cloud worker and tests use them; their layout does
  not depend on the storage family.
- **Previously patched Electron.** Older `electron:alpha` runs renamed
  `node_modules/electron/dist/Electron.app` to "Zeros Dev" in place; nothing
  patches it now, and `pnpm install --force` restores stock Electron.
- **Retired Zeros Dev desktop.** Zeros Dev (`pnpm electron:dev`,
  `pnpm electron:cloud`) is headless and keeps `~/.zeros-dev/` (profile,
  environments, dependencies, tools, auth, callbacks, agent GitHub App key). The
  `com.zeros.dev` desktop identity is no longer created; `pnpm storage:sweep`
  removes what it left.
