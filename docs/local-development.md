# Zeros Local development

Use `pnpm electron:local` on a Mac for UI and local feature testing without a
Zeros account. It opens the real desktop shell in the device-local organization
using the existing engine, SQLite database, Git, worktree, terminal, browser and
provider integrations. Renderer edits retain Vite HMR; engine and native edits
use the existing development watchers and main supervisor.

`pnpm electron:dev` remains the complete hosted application for sign-in,
organizations, billing, cloud workspaces and integration testing. Its launcher,
provisioning, errors, Setup and Archive behavior are unchanged. Local never
invokes that hosted lifecycle or reads its portable profile, registry receipts,
credentials or deployment state.

Run only one launcher from a checkout at a time: Local and hosted Dev (including
Alpha Dev) share `dist-electron` and `dist-engine`. Local refuses to build while
a Dev launcher from the same canonical checkout is running. Native main also
checks its baked build mode before initializing data or account services; a
rebuild from the other mode exits with an instruction to stop the other launcher
and relaunch. Use separate checkouts to run Local and Dev together.

## Start and stop

From this checkout on macOS, with the repository's Node/pnpm toolchain and
Apple Command Line Tools installed:

```sh
pnpm install --frozen-lockfile
pnpm electron:local
```

Only the root dependency graph is needed. The initial run verifies dependencies,
checks/rebuilds SQLite for Electron's ABI, builds ZSR, the engine and Electron
main/preload, then supervises Vite, both build watchers and the native app. Cold
compilation is expected; subsequent native ABI checks reuse a correct binding.
No backend deployment, database branch, Pages deployment or cloud worker
qualification is part of this command.

In Conductor, select **Zeros Local** from the run entries on a Mac. The shared
settings entry is available in the local environment and does not change either
existing Dev/backend entry or their defaults. It uses the repository's tool
selector when present: qualified Node 22.18+ in the 22.x line from
`~/.zeros-dev/tools/bin`, Homebrew `node@22`, or PATH. Selection does not install
tools or invoke hosted Setup/hooks. An older branch without `electron:local`
reports that it must rebase onto main or use Dev.
Conductor reads shared settings
from the default branch; until this change is merged, run the package command
directly. For a cloud workspace with file sync, run it from the synced checkout
on the Mac: the Linux VM cannot launch the native macOS application, and file
sync does not install the Mac's dependencies.

Stop with Ctrl+C or Conductor Stop. Hangup and SIGQUIT also cancel the launch.
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

Local has no Zeros user, access token, WorkOS session or substitute account.
The organization menu has no sign-in action. Settings → Account explains the
account-free mode and directs sign-in testing to Zeros Dev.
Native main enables it only for the explicit unpackaged development launch.
Preload obtains that decision directly from main before the renderer starts.
Packaged Alpha/Beta/Production and full Dev retain their login boundary; Vite
variables and renderer/process arguments cannot enable Local admission.

Account/organization/cloud requests, account security monitoring, cloud replica
refresh, hosted GitHub App refresh, OAuth deep links and product analytics are
disabled. Local does not claim any hosted Dev or packaged callback scheme. The
normal loopback host, origin and per-boot token checks remain in force, as does
the existing remote account authentication policy. Local does not start a relay
or cloud transport.

Provider CLI credentials are separate from a Zeros account. Real agents still
need their normal provider authentication, and provider/GitHub CLI operations
may use the network when requested. Native provider settings and PAT credentials
can be configured in Local's own profile. Hosted GitHub App integration and
staff/account-authorized internal features require the complete hosted app.

The organization selection continues to use the persisted compatibility key
`local-personal` (the existing Personal/Local entry). Its workspace ownership is
`organizationId: null`. No fake organization or parallel database/engine is
introduced. A stale collaborative selection cannot take over Local startup.

## Concurrent checkouts and retained data

Each canonical checkout path derives a stable 16-character SHA-256 identity.
Ordinary clones, synced checkouts with a `.git` directory and linked worktrees
all get separate profiles. Symlink aliases of one checkout share its profile.
Branch switches and relaunches preserve data. Moving the checkout to a different
canonical path selects a new profile; keep the old directory if its data is
needed. The readable app name includes the checkout folder and a short identity
suffix so identically named folders can be distinguished.

| State on macOS                                                  | Location                                                                  |
| --------------------------------------------------------------- | ------------------------------------------------------------------------- |
| SQLite, native settings, isolated secrets, single-instance lock | `~/Library/Application Support/com.zeros.local.<identity>/`               |
| Chromium cache, cookies and renderer storage                    | `~/Library/Caches/com.zeros.local.<identity>/`                            |
| Native logs                                                     | The existing per-identity log location under `com.zeros.local.<identity>` |
| User settings, default-project sentinel and engine state        | `~/.zeros-local/instances/<identity>/`                                    |
| Native development bundle and version marker                   | `~/.zeros-local/instances/<identity>/bundle/`                              |
| Product worktrees                                               | `~/zeros-local-<identity>/workspaces/` and sibling `design workspaces/`   |

Local never migrates hosted Dev/packaged secrets or Chromium state into its
profile. It also starts with its own user settings instead of seeding them from
the installed app. Stopping the command does not remove SQLite or workspace
data. Local profiles are not pruned by the hosted Dev launcher.

To delete an old profile, stop its launcher first and remove its identity's
directories: `~/Library/Application Support/com.zeros.local.<identity>/`,
`~/Library/Caches/com.zeros.local.<identity>/`,
`~/Library/Logs/com.zeros.local.<identity>/`,
`~/.zeros-local/instances/<identity>/` (including its `bundle/` cache), and
`~/zeros-local-<identity>/`. Older runs may also have
`~/.zeros-local/dev-instances/<identity>/`; Local removes that old bundle cache
best-effort when preparing the new one.
The visible worktree directory contains project work and uncommitted changes;
keep any work you need before removing it. The checkout's
`.context/zeros-local/` contains only launcher coordination state.

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
