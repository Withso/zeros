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
| Session data | `zerosSessionDataDir()` | Electron `sessionData` (renderer storage and Chromium caches); currently the cache dir |
| Cache dir | `zerosCacheDir()` | Regenerable Chromium caches |
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
| Cache / session data | `~/Library/Caches/<id>/` | `~/.cache/<id>/` | `%LOCALAPPDATA%/<id>/` |
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
| Cache / session data | `~/Library/Caches/com.zeros.local/instances/<inst>/` |
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
