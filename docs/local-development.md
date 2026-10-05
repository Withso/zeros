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
existing Dev/backend entry or their defaults. Conductor reads shared settings
from the default branch; until this change is merged, run the package command
directly. For a cloud workspace with file sync, run it from the synced checkout
on the Mac: the Linux VM cannot launch the native macOS application, and file
sync does not install the Mac's dependencies.

Stop with Ctrl+C or Conductor Stop. Cancellation signals the owned preparation
or development process group and waits for shutdown; the existing native main
supervisor and sidecar clean up the engine and its children. Forced escalation
is bounded to 20 seconds. One launcher per checkout is allowed. A dead
launcher's `.context/zeros-local/launcher.lock` is recovered on the next run;
an incomplete lock reports an actionable error instead of stealing a live run.

## Accounts and network services

Local has no Zeros user, access token, WorkOS session or substitute account.
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
| Native development bundle                                       | `~/.zeros-local/dev-instances/<identity>/Zeros Local … .app`              |
| Product worktrees                                               | `~/zeros-local-<identity>/workspaces/` and sibling `design workspaces/`   |

Local never migrates hosted Dev/packaged secrets or Chromium state into its
profile. It also starts with its own user settings instead of seeding them from
the installed app. Stopping the command does not remove SQLite or workspace
data. Local profiles are not pruned by the hosted Dev launcher.

Vite selects from ports 6200–7223. Engines use disjoint 10-port blocks in
31000–36119, including the existing eight-port engine walk and two gateway ports.
The launcher probes IPv4, IPv6 and wildcard listeners, checks the entire engine
block and retries observed bind races up to three launches without changing the
profile. Local ignores inherited desktop identity, profile, port and data-root
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
and the running app. Run `pnpm smoke:engine` on macOS. Linux unit/build/browser
checks do not substitute for these native macOS checks.
