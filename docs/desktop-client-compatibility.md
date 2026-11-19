# Desktop compatibility

## Channel support window

Desktop user-facing control-plane requests carry
`X-Zeros-Client: desktop/<channel>/<version>`. Channels on this boundary are
`alpha`, `production`, and `dev`. The existing persisted/build channel
`stable` is translated to `production` only for this header and analytics;
application identities, data directories, feeds, IPC names and deep links are
unchanged. Electron main supplies the installed version and authoritative
channel; the renderer shares one app-info lookup across requests. Unpackaged
development runtimes use the always-supported `dev` request identity, even
when channel-branded, matching Electron main and avoiding a mandatory updater
that cannot install in an unpackaged build.

Older APIs may omit the client header from their CORS allow-list. When a
header-bearing GET or HEAD rejects with `TypeError`, the shared renderer/main
request wrapper retries exactly once without the header. If that retry resolves
with any HTTP status, requests to that API origin omit the header for ten
minutes, then try it again so an API upgrade restores compatibility enforcement.
This in-memory cache retains at most 32 origins. POST/PUT/PATCH/DELETE never retry,
even with an idempotency key; after successful learning they omit the header on
their initial send. Account fences run before every send, and 426 handling
remains active on both attempts. Identity/fence errors and other fetch error
types do not trigger fallback; if both GET/HEAD attempts fail, no rejection is
remembered. Electron main has no CORS preflight but shares the bounded retry.

Each channel publishes a cumulative release ledger with its desktop feed:

| Channel    | Public ledger asset under `https://github.com/withso/zeros/releases` |
| ---------- | -------------------------------------------------------------------- |
| Alpha      | `/download/alpha/alpha-release-ledger.json`                          |
| Production | `/latest/download/release-ledger.json`                               |

The asset is versioned JSON, with `version: 1`, its exact channel, and
`releases` ordered oldest to newest. Each entry contains `version`, UTC
`publishedAt`, and a 40-hex `sourceSha`. Publication retains every entry from
the last 30 days plus the newest entry before them, because that version stays
supported while its successor is inside the window. A busy channel such as
Alpha therefore keeps its whole support window. The ledger holds at most 2,000
entries and 512 KiB; the writer, control plane and agent-runtime reader share
those bounds (`scripts/__tests__/release-ledger-limits.test.ts`).

For a client version V, the newest version is always supported. Otherwise, V
is supported until 30 days after the **next newer** entry's publication, not
30 days after V's publication or the latest release's publication. Exactly at
that deadline it becomes unsupported. Versions before the oldest retained
entry are unsupported; unreleased versions newer than the newest entry are
allowed. A channel's first ledger lists only the release that created it, and
there is deliberately no grace period or history backfill: a header-sending
version older than that entry is unsupported immediately. Desktops before
0.1.20 send no header and are therefore never blocked. Unknown/dev channels, invalid/unknown versions and absent headers
are allowed. The missing-header allowance intentionally preserves the web
app and pre-feature desktops; this is compatibility negotiation, not an
authentication or tamper-resistance boundary.

The control plane keeps at most three exact-channel cache entries, shares
in-flight reads, and caches success for five minutes. Reads have a three-second
timeout, a 512 KiB response limit, and strict ledger validation. Failures log
only the channel and a safe warning, allow requests, and retry after 30 seconds.
An expired snapshot is not used to enforce a minimum during an outage.

`DESKTOP_RELEASE_LEDGER_URL` optionally overrides the asset URL for the control
plane's deployment channel. It must be credential-free HTTPS with no query or
fragment; unset means the channel-derived GitHub URL. Other recognized client
channels keep their own defaults rather than borrowing that channel's ledger.

Unsupported desktops receive HTTP 426 with:

```json
{
  "error": {
    "code": "client_upgrade_required",
    "message": "This version of Zeros is no longer supported. Update Zeros to continue.",
    "minimumVersion": "0.1.20-alpha.181",
    "latestVersion": "0.1.20-alpha.182"
  }
}
```

`minimumVersion` is the oldest currently supported ledger entry. Responses
are not cacheable. Health, release identity, authentication sign-in/refresh/
logout, engine/internal routes and CORS preflights are exempt. Actual WorkOS
authentication routes live outside `/v1`; `/v1/auth/snapshot`, devices and cloud
workspace operations remain user routes and are not exempt. Normal bearer
authentication, authorization and rate limits still apply to allowed requests.

## Released-client contract replay

The support window only holds if a new control plane still answers every
supported desktop the way that desktop parses. CI checks this directly:

- `apps/desktop/src/renderer/platform/control-plane-contract.ts` lists the
  requests the app sends (method, path with `{organizationId}`, `{workspaceId}`
  or `{chatId}` placeholders, and opt-in headers) and the exact zod schema each
  call site parses the reply with. Call sites import those schemas and header
  constants, so the list cannot describe a different request.
- Its JSON form, with each schema written by `z.toJSONSchema` in input mode, is
  committed as `apps/control-plane/src/client-contracts/desktop-next.json`. A
  desktop test fails until `pnpm client-contract:update` regenerates it.
- When a release ships, `pnpm client-contract:release X.Y.Z` copies that tag's
  `desktop-next.json` to `released/desktop-X.Y.Z.json` and keeps the newest two.
- `released-clients.integration.test.ts` boots the control plane in-process on
  the execution fixture's Postgres data, sends every kept contract's requests,
  and checks each reply with `z.fromJSONSchema` of that release's schema. A new
  enum value, a removed or retyped required field, or a non-2xx reply fails.
  Added fields pass, as they do in the app's parsers.

The cloud worker runtime has the same contract, because the previous pin keeps
talking to a new control plane during a handover
([Cloud workspaces](cloud-workspaces.md)).
`apps/cloud-worker/src/control-plane-contract.ts` lists the boot sequence
(hello, config, activity), the bodies the transport builds through the same
helpers, and the advertised `X-Zeros-Worker-Features`. Its committed copy is
`worker-next.json`, and `pnpm client-contract:release` keeps
`released/worker-X.Y.Z.json` beside the desktop copy. The replay runs each
kept runtime's sequence as one boot. `main` has no merge queue, so two PRs
that each pass can still merge into a stale committed contract (a worker
feature added on a branch cut before the contract existed); the sync test then
turns `main` red, and the fix is `pnpm client-contract:update`. Config frames are strict, so a field the
control plane sends without checking that runtime's advertised features fails
with `unrecognized_keys`.

Refinements and transforms JSON Schema cannot express are left out, so the
check can miss a break but does not invent one. It covers the listed cloud
workspace reads and the worker boot sequence today; extend the lists rather
than writing per-feature N-1 tests for calls they can replay.

## Required update behavior

A 426 immediately opens the non-dismissable **Update required** screen above
the sign-in gate. Existing agent/session providers stay mounted and working.
The screen checks the channel's signed updater feed and downloads without
arming an install-on-download latch. Escape/outside clicks do not dismiss it;
its keyboard and native-browser overlay boundaries keep underlying surfaces
from receiving the screen's interactions.

Restart is possible only after native installer staging of at least the
minimum supported version. On macOS, electron-updater's early ZIP completion
does not qualify: Squirrel must confirm staging. Automatic restart waits for
30 continuous idle seconds across all agents, queued/optimistic work and
background activity, and rechecks current activity at the deadline. The main
process independently rejects an unstaged or obsolete staged install.
**Restart now** is an explicit, labeled action; the screen warns that it
interrupts running work. Failures remain actionable through Check again.
Normal user-initiated quit/install-on-quit behavior is unchanged.

Required metadata is retained in the monotonic main-process updater snapshot,
including renderer window recreation, and is merged monotonically so a late
older response cannot lower the minimum. The additive `required` field and
`updater_require` command carry validated version metadata only, never remote
error text. Malformed 426 bodies still block with safe, unknown-version copy.

## Update downloads

The updater checks the channel feed at launch, every five minutes and on window
focus or wake, and downloads a newer build in the background. It always
downloads the complete archive: the release CDN rejects the multi-range requests
a differential download makes (HTTP 501), so differential downloads stay off.

Once a build is staged, a newer feed build replaces it at most once an hour, so
a busy channel does not download every build. Each replacement attempt restarts
that hour, including a failed one. A required minimum above the staged build
replaces it at once. A staged build that already meets the required minimum is
never replaced while the requirement stands, so the mandatory restart is not
pushed back. Without automatic restart, the staged build installs on the next
quit, as before.

## Release candidates (Production app)

Settings → Internal → **Release candidates** lets a staff account's Production
app follow the rolling `rc` prerelease, where each release is published before
it becomes Latest ([release candidates roadmap](release-candidates-roadmap.md)).
The renderer reports the effective value (staff role AND the Internal flag) to
Electron main through `updater_release_candidates` only once `/v1/me` has
resolved, so a signed-out launch keeps main's last choice. Main persists it in
`release-candidates.json` in `userData` and applies it from the launch check.

When it is on, each check reads `rc-mac.yml` and `latest-mac.yml` and follows
`rc` only when its version is newer; a missing or broken `rc` feed falls back to
Latest. The staged-build comparison uses the same choice, so a newer candidate
still replaces a staged Latest build after the hourly hold. Downgrade stays off:
turning it off keeps the installed candidate until a newer release. An app that
never opted in keeps its baked feed. Alpha and Dev ignore the choice.
Candidates are Production builds, so request headers, analytics and the
release ledger see `production` and the candidate's version.

## Update relaunch recovery (macOS)

After installing a staged update, Squirrel's ShipIt relaunches the app through
LaunchServices. LaunchServices can fail that launch with `-600`
(`procNotFound`) after launchd has already spawned the new app suspended. The
suspended process never runs, yet it stays the app's launchd job, so every
later open fails with "The application is not open anymore" until it is
killed.

Every update restart (Restart now, Restart to Update, the automatic idle
restart and required updates) therefore starts a detached `/bin/sh` guard
(`apps/desktop/electron/relaunch-guard.ts`) just before `quitAndInstall`. It
arms only for an executable inside a macOS `.app` bundle. Once the old app
exits it watches for up to three minutes: processes that existed before the
restart are never candidates, a running new instance ends the watch, and an
instance still stopped after ten seconds is killed and the bundle reopened, at
most twice, with a `relaunch guard` line in `main.log`. Quitting normally with
install-on-quit does not relaunch and starts no guard. To recover an install
that predates the guard, kill the app process that `ps` shows in state `T`,
then open the app.

## Analytics

All events register the metadata-only `release_channel` super property:
`alpha`, `production`, or `dev`. Registration precedes startup and
buffered events. Use the existing public `VITE_POSTHOG_KEY_PROD` build variable
for the single shared project, including Dev; `VITE_POSTHOG_KEY_DEV` remains a
legacy contributor fallback only when the shared key is absent. Existing
opt-out storage, anonymous identity, disabled autocapture/session recording
and runtime metadata remain unchanged. No PostHog project/settings writes are
performed by this code.

## Cloud capability boundary

Cloud v2 hides Design, browser and simulators. Terminal, file and Git operations
go through the control plane's connection into the worker; the retired preview
grants, SSH access broker and desktop
port-forwarding runtime are removed. Local browser and preview behavior stays
with the Local engine. See [Cloud workspaces](cloud-workspaces.md).
