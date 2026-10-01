# Desktop compatibility and preview-free cloud releases

## Channel support window

Desktop user-facing control-plane requests carry
`X-Zeros-Client: desktop/<channel>/<version>`. Channels on this boundary are
`alpha`, `beta`, `production`, and `dev`. The existing persisted/build channel
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
| Beta       | `/download/beta/beta-release-ledger.json`                            |
| Production | `/latest/download/release-ledger.json`                               |

The asset is versioned JSON, with `version: 1`, its exact channel, and
`releases` ordered oldest to newest. Each entry contains `version`, UTC
`publishedAt`, and a 40-hex `sourceSha`; retain the newest 200 entries.

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
timeout, a 64 KiB response limit, and strict ledger validation. Failures log
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

## Analytics

All events register the metadata-only `release_channel` super property:
`alpha`, `beta`, `production`, or `dev`. Registration precedes startup and
buffered events. Use the existing public `VITE_POSTHOG_KEY_PROD` build variable
for the single shared project, including Dev; `VITE_POSTHOG_KEY_DEV` remains a
legacy contributor fallback only when the shared key is absent. Existing
opt-out storage, anonymous identity, disabled autocapture/session recording
and runtime metadata remain unchanged. No PostHog project/settings writes are
performed by this code.

## First cloud release: previews off

Leave `VITE_CLOUD_WORKSPACE_PREVIEW_HOST_SUFFIXES` unset for the first cloud
release. Cloud workspace Preview/Open controls, run-log preview reads,
composer boundary-port preview controls, direct preview-grant attempts, Browser
localhost suggestions and restored cloud preview tabs are gated off. Manual
VM-local Browser navigation is rejected before loading an iframe. Local
workspace previews, conversation-owned agent Browser surfaces and ordinary
external Browser pages keep their behavior.

Cloud-enabled builds no longer require preview suffixes. When supplied, the
release validator still requires 1–8 unique, exact lowercase DNS suffixes,
including when the cloud capability is off. A suffix alone does not provide
routing. A later preview-enabled release must qualify matching
`CLOUD_WORKSPACE_PREVIEW_BASE_DOMAIN`, wildcard DNS/TLS and the authenticated
proxy before adding the public suffix to both renderer and Electron builds.
Native development/self-host overrides remain validated; also supply the
renderer `VITE_*` setting to expose the corresponding UI. Never weaken the
preview origin/capability boundary to substitute a VM-local localhost URL.

Independent tunnels remain intact:

- `cloud_workspace_tunnel_start` / `startCloudWorkspaceTunnel` requests a
  device- and port-scoped `kind: tunnel` grant. The broker binds only
  `127.0.0.1`, and the SSH runtime uses pinned gateway access with OpenSSH `-L`
  to the remote loopback port. Neither issuance nor forwarding requires a
  preview base domain or suffix. Daytona's SSH host/pin release checks remain
  mandatory; managed Boat builds do not require Daytona SSH pins.
- Cloud engine/runtime access uses its separate admission and control-plane
  WebSocket/SSH transport, not the preview origin. Disabling preview URLs does
  not disable agents or runtime terminals. This does not claim a new Boat
  application-port-forward implementation or live provider qualification.

Evidence lives in `cloud-workspace-access.ts`, the main access broker/client
and SSH runtime, and control-plane `cloud-workspaces/access.ts`: the missing
preview-domain rejection applies only to `kind: preview`. Domain-free unit
coverage retains tunnel calls; real SSH/provider routing remains a separate
platform acceptance check.
