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
| Session data | `zerosSessionDataDir()` | Electron `sessionData`: `<data dir>/electron` (durable renderer state, plus the caches Chromium will not relocate) |
| Cache dir | `zerosCacheDir()` | Regenerable caches Electron can relocate (the JS code cache) |
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
| Session data | `~/Library/Application Support/<id>/electron/` | `<data>/electron/` | `<data>/electron/` |
| Cache | `~/Library/Caches/<id>/` | `~/.cache/<id>/` | `%LOCALAPPDATA%/<id>/` |
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
| Cache | `~/Library/Caches/com.zeros.local/instances/<inst>/` |
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
  second concurrent launch fails before building, through the lock at
  `~/.zeros-local/instances/alpha/launcher.lock`. Moving off the retired
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

Electron's `sessionData` is `<data dir>/electron/` for installed channels and
consolidated development identities, so durable renderer state is no longer in
a folder cache cleaners empty. A legacy-layout Local profile keeps its session
in its cache dir (`Caches/com.zeros.local.<inst>/`). A `ZEROS_DATA_DIR` run
uses `<ZEROS_DATA_DIR>/electron/` and keeps every cache inside it.

Observed on Electron 43.8.3 / Chromium 150 (the prototype in the storage PR):

| Entry under `electron/` | Class |
| --- | --- |
| `Local Storage`, `IndexedDB`, `Session Storage`, `Cookies`, `WebStorage`, `Service Worker`, `blob_storage`, `Preferences`, `Local State`, `Network Persistent State`, `DIPS`, `Trust Tokens`, `Partitions/`; and any other name (`SharedStorage`, `TransportSecurity`, …) | Durable |
| `Cache` (HTTP, capped at 250 MB), `GPUCache`, `DawnWebGPUCache`, `DawnGraphiteCache`, `Shared Dictionary`, `Dictionaries` (spell-check downloads); also `GrShaderCache`, `GraphiteDawnCache`, `ShaderCache`, `VideoDecodeStats` where Chromium creates them | Regenerable, cannot be relocated |
| `Code Cache` | Regenerable; only an empty index here, the cache itself is in the cache dir |

The JS code cache is the one cache Electron can place elsewhere:
`session.setCodeCachePath()` points it at `<cache dir>/Code Cache` for the
default session and at `<cache dir>/Partitions/<name>/Code Cache` for any
persistent partition, applied from `app.on("session-created")`. Chromium
ignores `--disk-cache-dir`, and the GPU switches only disable those caches.
The app's other sessions (Browser leases, Design capture and recorder) are
in-memory partitions that write nothing to disk. The regenerable list is
`REGENERABLE_SESSION_ENTRIES` in `apps/desktop/src/engine/db/session-entries.ts`.

### Moving existing profiles

`apps/desktop/electron/session-data-migration.ts` runs once, before `app` is
ready, with the marker `electron/.zeros-session-relocated`. Sources, earliest
wins: the old `Caches/<id>/` session (for consolidated development identities,
`Caches/com.zeros.local/instances/<inst>/`), then for Stable only, and only
while the older hop never completed (no `Caches/com.zeros/.zeros-session-migrated`),
`Caches/design.zeros.app/`. Alpha no longer reads Stable's old folder.

It runs before the first window on every user's first launch after updating,
so it never deletes recursively and never copies a cache: each entry is one
rename (a 334 MB, 3,752-file profile took under 4 ms on the development VM).

- Every entry not on the regenerable list moves, unknown names included.
  Moves are a rename or a no-replace hard link. Across volumes a durable entry
  is copied to a private temporary, verified byte for byte and published; the
  source stays in the purgeable cache folder. A failed verification publishes
  nothing.
- Regenerable caches Chromium will not relocate (`Cache`, `GPUCache`, the Dawn
  caches, `Shared Dictionary`, …) move into `electron/` the same way, so they
  stay warm and the canvas keeps its compiled shaders. One that cannot be
  renamed (another volume, busy) is left behind and does not fail the run.
- `Code Cache` stays in `Caches/<id>/`, where the code cache now lives.
- From `Caches/design.zeros.app/` only durable entries move; its caches stay
  for the sweep and the OS.
- An existing destination entry is never replaced; that source entry stays.
- The marker is written only after a run with no failures, so an interrupted
  or failed run retries next launch, and two processes starting together each
  move only what the other has not.
- A failure never stops startup: the app opens whatever `electron/` holds and
  logs once.

**Known limit: downgrade.** A build from before this change reads renderer
state from `Caches/<id>/` again and finds none (drafts, theme and permissions
reset). The updater never installs an older build; a manual downgrade does.

## Bounded growth inside a profile

The engine's startup maintenance (`apps/desktop/src/engine/startup-maintenance.ts`,
after readiness, one task at a time) and the updater prune what they can prove
is unused. Every removal goes through
`apps/desktop/src/engine/db/contained-removal.cjs` (shared with the launcher
prune and `pnpm storage:sweep`). Each target sits directly inside its store and
nothing follows a symlink.

| Store | Pruned | Kept |
| --- | --- | --- |
| `engines/<repoKey>/` (`engine.json` manifest and `busy` heartbeat only) | An entry whose manifest's pid is dead or absent and whose recorded root no longer exists, or which records no root and was untouched for 30 days. At most 200 removals or 2 s per launch | The running engine's own entry; a live pid; a `busy` heartbeat under 30 s old; an unreadable or unparsable manifest; symlinks and non-engine names |
| `design-storage/` | Nothing new: pictures are kept within their byte budgets by the existing thumbnail sweep | Everything else. It holds Design recovery journals, review receipts, result bundles and retired private drafts, and records its owner only as a hash of the workspace path. `design-storage/recording-chunks/` is a known unbounded store until Design owns a sweep for unreferenced chunks |
| `git-promotion-journal/` | Nothing, and it has no Clear | All of it. A retired build wrote it; no current code reads it, and its records may describe unfinished work. The storage report counts it as other app data |
| `Caches/zeros-updater/` (macOS) | `pending/` download and `update-info.json` when the artifact name is this channel's and its version is the running one or older; the root `update.zip`, which this build never reads (differential downloads are off) | A newer download; another channel's download; anything whose file name or metadata cannot be read |
| `Caches/<bundle id>.ShipIt/update.*/` | A staged app for this bundle whose version is the running one or older | A newer staged app (installs on quit); unreadable or foreign staging; everything while a ShipIt process for this bundle runs; `ShipItState.plist` and logs |

The engine task runs only when the profile's single-instance holder, the
`SingletonLock` link in the data dir, is this engine's own Electron parent
(`ZEROS_PARENT_PID`). Standalone engines and `ZEROS_DATA_DIR` test engines
therefore never prune. The updater cleanup runs 30 s after launch, only in
packaged Stable or Alpha builds on macOS, only while this process holds the
single-instance lock and the updater is idle; otherwise it retries every five
minutes, at most six times.

Both are asynchronous end to end (process listing, reads and removal), so
neither stalls Electron main or the engine's event loop; on an owner-sized
profile (1,248 entries) the engine prune's worst event-loop delay was 4 ms.

Stable and Alpha share `Caches/zeros-updater/`: app-builder-lib names it after
`package.json` `name` (`zeros`), which both channels keep. Downloads are told
apart by artifact name (`Zeros-<version>-…-mac.zip` and
`Zeros-Alpha-<version>-…-mac.zip`). ShipIt staging is per bundle id. The
development family is never auto-updated; its engines prune the same way.

Follow-up, not in this change: give Alpha its own updater cache
(`-c.extraMetadata.name=zeros-alpha` in `scripts/electron-builder-run.mjs`
gives `zeros-alpha-updater`). It also renames the packaged `package.json`
`name`, so it needs a real Alpha release build to verify.

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
lock (`instances.json.lock`) whose dead or old holder is recovered. Unknown
fields and instances survive a rewrite. A corrupt file is renamed aside to
`instances.json.corrupt-<time>` and rebuilt empty. Each launch upserts its own
entry and `lastUsedAt`, legacy-layout identities included
(`scripts/local-instance-registry.mjs`).

## Prune at launcher start

`scripts/local-instance-prune.mjs` runs after the launcher's lock and
registration. It never throws or fails a launch, stops at a three-second
budget, skips the launching identity and any identity whose launcher lock or
ephemeral owner is live, removes only resolver-derived targets that sit
directly inside their expected folder under `$HOME`, and follows no symlink.

| Registered identity | Removed |
| --- | --- |
| `checkout` whose path is gone and `lastUsedAt` is over 14 days old | Bundle, cache, logs, preferences plist and the bundle-id folders macOS created. When its visible root holds no workspace entries and the shared store does not reference its data dir, also app data, state root, visible root and the registry entry; otherwise data and entry stay |
| `ephemeral` whose `ownerPid` is dead | Everything and the entry, unless the shared store references its data dir (then the regenerables only) |
| Any identity unused for 14 days whose bundle was built for another Electron | The bundle only |

A visible root holds no workspace entries only when it is missing or contains
nothing but empty `workspaces`, `design workspaces` and `cloud-sync` folders.
The shared Local store (`com.zeros.local/secrets.json`) references a data dir
when it carries that data dir's migration marker; because its records are
encrypted, an unreadable or malformed store counts as referencing every data
dir.

## `pnpm storage:sweep`

`scripts/storage-sweep.mjs` removes residue that predates the registry. Node
built-ins only, so it runs in a checkout without `node_modules`. It is a dry run
by default: it prints each category, path and allocated size (what `du`
reports, each hardlinked inode counted once), and a total.

The registry only knows identities launched since it was introduced, so every
older Local checkout is "unregistered" until its next launch. **Launch each
checkout you still use once before sweeping.** As a guard, an unregistered
checkout identity whose `zeros.db` or `zeros.db-wal` changed in the last 14 days
is skipped whole as "used recently" unless named with `--identity`.

```sh
pnpm storage:sweep                       # dry run
pnpm storage:sweep --apply               # delete what the dry run lists
pnpm storage:sweep --only beta,dev-desktop
pnpm storage:sweep --identity <inst>     # one identity; lifts its "has workspaces" skip
pnpm storage:sweep --keychain            # also Zeros Dev / Zeros Beta Safe Storage
```

| Category | Matches |
| --- | --- |
| `dev-desktop` | `com.zeros.dev`, `com.zeros.dev.*`, `Zeros Dev`, `Zeros — *`, `design.zeros.app.dev*` in Application Support, Caches, Logs, Preferences (`.plist`), HTTPStorages, WebKit and Saved Application State; `~/.zeros-dev/dev-instances`; `~/zeros-dev*` |
| `beta` | `com.zeros.beta*`, `design.zeros.beta*` in the same folders; `~/.zeros-beta`; `~/zeros-beta` |
| `legacy-scheme` | `design.zeros.app`, `design.zeros.oCanvas` in the same folders |
| `local-unregistered` | Local identities absent from the registry, in both layouts (including the `com.zeros.local.<inst>` entries in HTTPStorages, WebKit and Saved Application State), and `~/.zeros-local/dev-instances` |
| `local-orphaned` | Registered checkouts whose checkout path is gone |

Safety: an identity whose visible root contains any workspace entry is skipped
whole and listed as "has workspaces" unless named with `--identity`; `--apply`
checks each visible root again just before removal and keeps the identity if it
gained an entry since the dry run. A Local data dir the shared provider store
references is kept, with its state and visible roots, even with `--identity`;
its regenerable folders are still removed. Anything a
running process's command line references is skipped, and everything is
skipped when the process list cannot be read. Targets match exact patterns and
must be a real file or directory directly inside its expected folder under
`$HOME`; symlinks are refused. `--keychain` checks for the two Safe Storage
items without reading them and deletes them only with `--apply`.

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
