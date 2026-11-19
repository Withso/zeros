# Zeros Local development

Use `pnpm electron:local` on a Mac for UI and local feature testing without a
Zeros account. It opens the real desktop shell in the device-local organization
using the existing engine, SQLite database, Git, worktree, terminal, browser and
provider integrations. Renderer edits retain Vite HMR; engine and native edits
use the existing development watchers and main supervisor. To test a branch's
cloud workspaces before merge, use [Zeros Dev](electron-cloud.md) (`pnpm electron:dev`).

Zeros Dev is the complete application for sign-in, organizations, cloud
workspaces and integration testing. Local never invokes the Zeros Dev lifecycle
or reads its private profile, credentials or launcher state.

Run only one launcher from a checkout at a time: Local and `electron:alpha`
share `dist-electron` and `dist-engine`. Local refuses to build while
an `electron:alpha` launcher from the same canonical checkout is running. Native main also
checks its baked build mode before initializing data or account services; a
rebuild from the other mode exits with an instruction to stop the other launcher
and relaunch. Use separate checkouts to run Local and `electron:alpha` together.

## Start and stop

From this checkout on macOS, with the repository's Node/pnpm toolchain and
Apple Command Line Tools installed:

```sh
pnpm install --frozen-lockfile
pnpm electron:local
```

Only the root dependency graph is needed. The initial run verifies dependencies,
checks/rebuilds SQLite for Electron's ABI, stages pinned ripgrep, builds the engine and Electron
main/preload, then supervises Vite, both build watchers and the native app. Cold
compilation is expected; subsequent native ABI checks reuse a correct binding.
No backend deployment, database branch, Pages deployment or cloud worker
qualification is part of this command.

In Conductor, select **Zeros Local** from the run entries on a Mac. The shared
settings entry is available in the local environment and does not change either
existing Dev/backend entry or their defaults. It runs the repository's tool
selector and launch under POSIX `sh`, including when Conductor starts in zsh:
qualified Node 22.18+ in the 22.x line from
`~/.zeros-dev/tools/bin`, Homebrew `node@22`, or PATH. Selection does not install
tools or invoke hosted Setup/hooks. An older branch without `electron:local`
reports that it must rebase onto main or use Dev.
Conductor reads shared settings
from the default branch; until this change is merged, run the package command
directly. For a cloud workspace with file sync, run it from the synced checkout
on the Mac: the Linux VM cannot launch the native macOS application, and file
sync does not install the Mac's dependencies.

Stop with Ctrl+C or Conductor Stop. Hangup and SIGQUIT also cancel the launch.
Quitting the app normally returns success; a crashed command still fails the run.
Cancellation signals the owned preparation
or development process group and waits for shutdown; the existing native main
supervisor and sidecar clean up the engine and its children. Forced escalation
is bounded to 20 seconds and completion waits for all live group members, even
when the direct child exits first. A watchdog tears down owned processes if the
launcher is killed or crashes; fatal launcher/output errors cancel and release
the lock. One launcher per checkout is allowed. A dead
launcher's `.context/zeros-local/launcher.lock` is recovered on the next run;
recovery is serialized, ownership uses a random token, and release cannot remove
a replacement owner's record. A live PID blocks startup only if it still
belongs to a Local launcher. An incomplete lock reports an actionable error
instead of stealing a live run.

## Accounts and network services

The renderer and marketing Vite servers bind to loopback by default and serve
only explicit application source roots. Environment files, credentials, private
workspace state and databases remain denied, including through `public` and
resolved aliases. For an authenticated remote preview, explicitly set
`ZEROS_DEV_BIND_HOST` and the comma-separated exact hostnames in
`ZEROS_DEV_PREVIEW_HOSTS`; do not use a wildcard host allowlist. The standalone
loader showcase is also loopback-only and bounds paths and file responses.

Development engine builds copy `sass-host.cjs` and
`host-process-supervisor.mjs` beside `dist-engine/cli.js`. Packaged Electron
supplies absolute product-resource paths for these helpers and the owned Node
runtime. Helpers never resolve from the workspace being opened. Rebuild the
engine after changing these assets; a missing trusted helper fails closed.

Local has no Zeros user, access token, WorkOS session or substitute account.
The organization menu has no sign-in action. Settings → Account explains the
account-free mode and directs sign-in testing to Zeros Dev.
Native main enables it only for the explicit unpackaged development launch.
Preload obtains that decision directly from main before the renderer starts.
Packaged Alpha/Production and full Dev retain their login boundary; Vite
variables and renderer/process arguments cannot enable Local admission.

Account/organization/cloud requests, account security monitoring, cloud catalog
refresh, hosted GitHub App refresh, OAuth deep links and product analytics are
disabled. Local does not claim the Zeros Dev or packaged callback schemes. The
normal loopback host, origin and per-boot token checks remain in force, as does
the existing remote account authentication policy. Local does not start a relay
or cloud transport.

Provider CLI credentials are separate from a Zeros account. Real agents still
need their normal provider authentication, and provider/GitHub CLI operations
may use the network when requested. Native provider settings and PAT credentials
can be configured in Local's own profile. Settings → Internal is available by
default in this trusted native development mode, with eligible features enabled
unless explicitly turned off. Hosted GitHub App integration and owner-only
release operations still require the complete hosted app and its authorization.

The organization selection continues to use the persisted compatibility key
`local-personal` (the existing Personal/Local entry). Its workspace ownership is
`organizationId: null`. No fake organization or parallel database/engine is
introduced. A stale collaborative selection cannot take over Local startup.

## Concurrent checkouts and retained data

Each canonical checkout path derives a stable 16-character SHA-256 identity.
Ordinary clones, synced checkouts with a `.git` directory and linked worktrees
all get separate profiles. Launching through a symlink alias of a checkout uses
the same canonical checkout and profile.
Branch switches and relaunches preserve data. Moving the checkout to a different
canonical path selects a new profile; keep the old directory if its data is
needed. The readable app name includes the checkout folder and a short identity
suffix so identically named folders can be distinguished.

New profiles use the consolidated development layout (one `com.zeros.local`
folder per kind, the identity as a subfolder); see
[storage layout](storage-layout.md) for every root, the instance registry, the
launch-time prune and `pnpm storage:sweep`.

| State on macOS                                              | Location                                                                     |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------- |
| SQLite, native settings, single-instance lock              | `~/Library/Application Support/com.zeros.local/instances/<identity>/`        |
| Shared encrypted provider credentials and account profiles | `~/Library/Application Support/com.zeros.local/`                             |
| Instance registry                                           | `~/Library/Application Support/com.zeros.local/instances.json`               |
| Cookies and renderer storage                                | `~/Library/Application Support/com.zeros.local/instances/<identity>/electron/` |
| Regenerable Chromium code cache                             | `~/Library/Caches/com.zeros.local/instances/<identity>/`                     |
| Native development bundle and version marker               | `~/Library/Caches/com.zeros.local/bundles/<identity>/`                       |
| Native logs                                                 | `~/Library/Logs/com.zeros.local/<identity>/`                                 |
| User settings, default-project sentinel and engine state    | `~/.zeros-local/instances/<identity>/`                                       |
| Product worktrees                                           | `~/zeros-local/<identity>/workspaces/` and sibling `design workspaces/`      |

A profile created before this layout keeps its original locations, because its
database and Keychain-bound provider profiles hold absolute paths:
`com.zeros.local.<identity>` under Application Support, Caches (including its
renderer storage) and Logs,
`~/.zeros-local/instances/<identity>/bundle/` and `~/zeros-local-<identity>/`.
The launcher detects one by its data folder and exports
`ZEROS_LOCAL_LAYOUT=legacy` for that launch; the engine strips it from
terminals and tools like the Local mode itself.

Local never migrates hosted or packaged secrets or Chromium state into its
profile. It also starts with its own user settings instead of seeding them from
the installed app. Stopping the command does not remove SQLite or workspace
data.

Local provider authentication is shared across checkouts by default. API keys,
saved subscription accounts and the selected method persist independently of
each checkout's database and renderer preferences. `pnpm electron:alpha` keeps
its account store in its own `instances/alpha/` profile; Local, `electron:alpha`
and packaged channels remain separate.
`ZEROS_ISOLATE=1 pnpm electron:local` explicitly keeps a checkout's secrets private.

On the first shared launch from an older Local checkout, only its provider
credentials migrate into missing shared slots. Existing shared values win. The
old store remains recoverable, and a migration marker prevents deleted keys
from returning. Migrated Claude/Codex profiles retain their original path because
native Keychain entries depend on it, so the launch-time prune and
`pnpm storage:sweep` keep any old checkout's data folder that the shared store
references. Keep those profile directories when removing an old checkout's data
by hand. See [provider accounts](provider-accounts.md).

Each launch registers its profile, then prunes other development profiles:
regenerable folders of a checkout that has been gone for 14 days (and its whole
profile once its visible folder holds no workspaces), test identities whose
owning process has exited, and stale bundles built for another Electron. It
never touches a profile with a running launcher. Profiles that predate the
registry, and the retired Zeros Dev desktop's folders, are listed and removed
by `pnpm storage:sweep` (a dry run unless `--apply`; it skips any identity whose
visible folder holds workspaces, or whose database changed in the last 14 days,
unless named with `--identity`). Launch each checkout you still use once before
sweeping, so it is registered. The visible
worktree directory contains project work and uncommitted changes; keep any work
you need before removing it. The checkout's `.context/zeros-local/` contains
only launcher coordination state.
Launcher locks use ownership tokens, verify stale PIDs, and serialize recovery.
An abandoned recovery fence can be reclaimed after 30 seconds.

The bundle path and state root use one shared path resolver. Local uses the same
containment policy as the hosted and packaged app, including host access for code
actors and protected engine roots for Design agents.

Vite selects from ports 6200–7223. Engines use disjoint 10-port blocks in
31000–36119, including the existing eight-port engine walk and two gateway ports.
The launcher probes IPv4, IPv6 and wildcard listeners, checks the entire engine
block and retries observed bind races up to three launches without changing the
profile. Failed Vite ports and engine blocks are excluded from subsequent
attempts. Collision detection covers only Vite strict-port and engine bind
failures during startup; it stops after Vite and the engine are ready or after
two minutes. Later diagnostics or MCP gateway errors do not restart the app.
Local ignores inherited desktop identity, profile, port and data-root
variables. The engine also strips the Local mode from terminals/provider shells,
so launching another checkout there cannot inherit its parent's admission.

## Qualification

Focused regression suites cover native admission, renderer gating, account-free
selection, disabled requests, profile compatibility, port races and process-group
cancellation. The standard repository checks, UI build/smoke, Electron compile,
engine build, preload, protocol, hardening, packaging and license gates still
apply.

Before calling the native launcher qualified on macOS, run it in two different
checkouts with no Zeros account/profile, open a local project and restart each to
verify retained SQLite state. Check renderer HMR, a real provider-authenticated
agent and terminal, distinct app names/profiles, and Stop during both cold build
and the running app, including a terminal hangup. Check that a same-checkout Dev
run blocks Local and that a rebuild from the other mode exits with the actionable
mode error. Run `pnpm smoke:engine` on macOS. Linux unit/build/browser
checks do not substitute for these native macOS checks.
