# Cloud workspaces

Cloud v2 gives each workspace one Boat VM with a standalone
[`apps/cloud-worker`](../apps/cloud-worker/) process. The desktop shares its
chat, files, Git and terminal UI with Local. Cloud advertises Browser, Design
and simulators as unavailable. Local Personal and organization-local workspaces
keep their own engine, provider permissions and Host lifecycle.

Cloud requires a non-personal organization with `cloud_workspaces_allowed`.
Only the workspace creator can list, connect to or manage it, and they must
still belong to that organization. Organization admins manage the shared
Cloud Computer. Each person must also have current GitHub access to every
repository whose source is present in their workspace. Repository lists are
filtered through that person's GitHub connection; organization membership or
the GitHub App's installation alone does not grant repository access.

## VM, connections and runtime

The worker and native Claude, Codex and Cursor drivers run as Boat's stock
`user`, with Node 24 and checkouts at `/home/user/<owner>/<name>`. Agents have
full permissions inside the VM. The VM is the isolation boundary; session
directories and environment allowlists do not isolate conversations from one
another. The worker never imports the Local engine runtime.

The worker listens only on `127.0.0.1:41783`. On create and on every wake,
the control plane registers that port with Boat as a protected route
(`POST /sandboxes/{id}/host` with `localhost: true`). Boat serves it at
`https://<subdomain>-41783.on.boat.dev` and refuses any request without the
route's `_port_auth` cookie. The control plane stores the route URL and the
envelope-encrypted route token; neither appears in workspace documents or
reaches the Mac.

The app obtains a short-lived connection ticket through
`/v1/cloud-v2/workspaces/:id/connect` and opens
`/v2/cloud/workspaces/:id/bridge` on the control plane, as before. The control
plane connects in to the worker's `/v2/worker/bridge` through the Boat route
and relays existing bridge frames with a client identity. Before upgrading,
the worker verifies a single-use Ed25519 grant in `X-Zeros-Worker-Auth`, signed
by the control plane for this workspace and this worker boot and valid for at
most 60 seconds. Anything in the VM can read the route token, so the grant, not
the cookie, is the authority. Any control-plane replica can serve any
workspace: each dials the worker while it has app clients, so the realtime
role needs no app affinity. Multiple app connections can attach, and losing
one does not stop a turn. The control plane never dials a stopped workspace;
Boat's route hangs rather than refusing while the VM sleeps.

Hello binds the worker boot before building configuration, but keeps a new
create or wake in `creating` or `starting` until the configuration is authorized
for that exact boot, access epoch and login revision. The relay waits for
`running` before dialing. A lifecycle token-delivery step must still own the
allocation and stop generation, with no bound boot; a late step cannot rotate
the credential or restart a worker already configuring. Stop and checkout
failure can end a bound first boot before readiness is published.
A new boot on a running VM temporarily returns it to `starting`. Lifecycle
polling can resume that same VM and re-establish its idempotent protected route;
the matching runtime installer does not restart it, and the bound boot prevents
token rotation. A configured hello returns the workspace to `running`.

The worker serializes HTTP and relay configuration. Its first configuration
constructs the required checkout, session, MCP, agent and terminal services
before publishing its scope or admitting app requests. A failed or cancelled
initialization closes its owned resources; a corrected snapshot can retry
without leaving duplicate watchers or listeners. Stop and disposal prevent
a late initialization from publishing readiness. Stop still drains durable
history after an earlier configuration failure.

The initial GitHub checkout report runs outside this readiness wait. Reports
remain ordered within the worker boot, including a retry of initial services,
and outstanding report work is joined during flush and disposal.
`workspace.prepareGithub` still waits for a fresh post-publication checkout
confirmation before returning its result.

The desktop retries only transient ticket failures: HTTP 5xx, network failures
and request timeouts. It makes at most five attempts with 250, 500, 1000 and
2000 ms delays, within one 30-second ticket budget. Ticket acquisition counts
against the original three-minute open deadline. Abort, account or workspace
owner replacement, and an explicit Stop cancel pending requests and prevent
late checkout publication. Reconnect tickets always use `wake: false`.
Terminal refusals end the attempt immediately. The API keeps masking cloud
5xx responses, while logging only a known cause code and status server-side.

App tickets and open clients retain the creator's verified WorkOS session ID.
Signing out closes only that session's clients and expires its unused tickets;
other devices, running turns and worker credentials remain live. Admission,
app requests and security notifications recheck that session in the database,
with the relay heartbeat repairing missed notifications. Account, organization
and workspace authorization loss still revoke the whole workspace room.

The desktop keeps at most 16 live cloud connections, including admissions still
loading their first chat snapshot. When another workspace needs a connection,
it releases the least recently used idle connection. The selected workspace,
busy VMs and pending opens or wakes stay attached. If all 16 are in use, the
request asks the user to retry after one finishes connecting or becomes idle;
no app restart is needed. Releasing a desktop connection does not stop its VM,
agents or terminals. Its next explicit open reconnects through normal admission.

Released connections do not consume live capacity. The desktop retains up to
64 recently used retired chat snapshots; older history remains available from
the control-plane mirror without waking a VM. Account replacement and access
revocation still clear or prune the exact owner's connections and snapshots.
Local Personal and organization-local connections use the sidecar independently
of these cloud limits.

The worker keeps outbound HTTPS to the control plane under
`/v2/cloud/worker/*` for work that continues without an attached app: `hello`
and configuration, the history mirror, activity reports and GitHub
credentials. Each request carries the worker credential and the
worker's boot identity; history batches are sequenced per boot so a retried
batch is a no-op. When both peers negotiate `worker-push-v1`, an attached relay
carries activity reports and their acknowledgements. Each report checks the
current membership, workspace access epoch, worker credential fingerprint and
boot recorded by that socket's dial. The worker uses one relay for each report;
an unacknowledged report falls back to authenticated HTTPS after two seconds.
Its relay slot stays occupied until the delayed reply or socket close, so a
database delay neither detaches the app nor overlaps relay activity reports.
Busy work still refreshes activity, while an idle safety pulse only reads
status. Its once-per-minute cadence has a random phase per worker, and returns
the login revision and a pending-prompt/Stop hint to repair missed notifications.
It neither renews source authority nor keeps the VM awake.

A renderer `workspace.list` row from the worker uses native
paths and the workspace UUID, not the HTTP workspace document shape; the
renderer translates native checkout paths and IDs into scoped `cloud://`
identities.

On create and wake, the control plane installs its selected runtime tarball
from object storage, verifies its SHA-256 and caches it under
`/opt/zeros/runtime/<sha256>`. `/opt/zeros/worker` points to that directory.
The runtime is root-owned; `zeros-worker.service` runs `worker.mjs` as `user`.
A resumed VM that already has the pinned runtime, unit, profile and keys exits
the install step after comparing them, with no lock, `sudo` or rewrite. The unit
keeps Node's compile cache in `/home/user/.cache/zeros/node-compile-cache`, and
the worker loads the Claude Agent SDK on its first Claude turn rather than at
start, so a wake parses less on a cold restored disk. Node writes that cache
only at a normal exit, which a stopped VM may never give the worker, so the
worker also writes it once connected and after loading the SDK. Install and
activation clear it before restarting onto another runtime, so it holds only
the current runtime's code.
The same step writes the control plane's public verification keys to
root-owned `/opt/zeros/worker-auth.json`. Cloud Computer builds install the
same keys, so a VM created from the org snapshot passes the fast path instead
of reinstalling (1.3–2.9 s per Alpha create before). The protected route is
created while the VM runs its runtime check and prune. It is inert until token
delivery, which follows them, starts the worker. A restore after a lost disk
still creates the route after its checkpoint is applied. Every wake rotates the worker
credential in `/home/user/.config/zeros/worker-token` (mode `0600`) and
restarts the worker, which registers a new boot identity in `hello` before the
control plane dials it. The worker rereads the credential on every HTTPS request.

Workers supporting `runtime-update-v1` can also adopt a changed pin while the
VM remains running. Adoption waits for 30 continuous quiet seconds with no
connected desktop, active or queued agent work, pending question or approval,
live PTY, setup, environment seeding, attachment transfer, durable prompt or
receipt, file/Git mutation, or outstanding tool work. Missing or uncertain
activity evidence defers the update until a later quiet period or natural wake.
The selected runtime comes from the same workspace resolver used at boot;
an admitted Alpha canary retains its candidate pin.

The control plane stages and verifies the archive without changing the active
link or credentials. The worker then freezes admission, flushes durable state,
and authorizes a one-use switch bound to its token, VM, boot, configuration,
source, access and Stop generations. A local permit races Stop's revocation
immediately before activation. Foreground work arriving after commitment waits
for the replacement. Commitment fixes a 120-second total deadline: the first
60 seconds cover activation, and the remaining time is reserved for restoring
the previous runtime. A control-plane restart, slow provider reply or another
rollback boot cannot renew that deadline. Hello and private readiness requests
each have a 30-second budget, including credential reads. Only the worker service restarts; adoption never stops,
resumes or checkpoints the VM. It emits no app notice or catalog state change.

The replacement boot remains private until fresh environment and service
readiness are committed. It retains the app's instance identity, persisted
executions and provider conversations, and does not rerun setup. Failed
activation restores the previous verified runtime privately; only server logs
record the failure. Interrupted private boots cannot reuse a readiness proof.
Rollback permits at most three fresh boots, and unresolved recovery keeps
foreground admission fenced. Recovery must publish the restored boot within
the original 120 seconds. If neither runtime can become ready within that
bound, the desktop ends its connection wait rather than waiting indefinitely;
no expired private boot gains authority. A later natural boot retires obsolete handoffs.
The VM retains the current and previous runtime, plus at most one prepared
candidate. Older workers update on natural wake. Deploy the migration and
control-plane support in every serving role before publishing a runtime that
negotiates in-place adoption. Local Personal and organization-local lifecycle
and permissions are unchanged.

The desktop's cloud handshake, readiness wait and unsent foreground reads share
one 120-second allowance across transient reconnect attempts. During that wait
the app retains its connecting state and existing content, with no new notice.
Stopped, failed or deleted workspaces, access or source revocation, and
definitive HTTP 4xx refusals end admission immediately. The outer workspace-open
operation retains its three-minute total cap, including ticket acquisition and
checkout confirmation; a dead worker cannot extend it with retries. Local
Personal and organization-local handshake, readiness and reconnect deadlines
are unchanged. The desktop change ships with the next Alpha feed; older
desktops retain their shorter connection wait.

Each organization has one Cloud Computer: a configured recipe and an active
named snapshot. Admins edit the recipe (repositories, branch or tag, setup
script) as an organization setting, saved at a revision so concurrent edits
from other admins or devices are refused rather than lost. Repositories stay
until an admin removes them. Settings shows the difference from the live build
as unbuilt changes, with Discard and Build computer; nothing changes for
workspaces until a build succeeds. Older apps that send the repositories with
the build still work, and their selection becomes the configured recipe.

A build always starts from Boat's stock image. It installs the pinned runtime
and git-lfs (configured system-wide; a build that can't install it still goes
live and says so in its log). The build's `source_policy_version` then decides
when the snapshot is captured:

- **v3**, the default since migration 0223: the build clones every recipe
  repository and runs its setup, recording each branch and commit. It
  restores any tracked file a setup rewrote, then captures the snapshot. The
  image holds every checkout and its dependencies, so a new workspace starts
  with its code on disk.
- **v2**, for a build queued by an older replica: the build captures a clean
  snapshot **before** any repository credential, clone or recipe script, then
  validates the repositories on the disposable builder.

Only a successful build becomes active. Deleting a checkout after setup is no
confidentiality boundary, because setup can copy source elsewhere. A v3 image
therefore starts only a workspace whose immutable `source_repositories` scope
covers the whole recipe (`cloudV2WorkspaceImage`). The source authority
re-verifies that scope on every create and wake.

The builder is deleted afterward. An inactive snapshot is deleted once no
creating workspace still needs it; its recipe remains in history. Activating
an older build rebuilds its selected commits on a fresh stock image and makes
its repositories the configured recipe. Build admission, execution and
activation require the original creator to remain an organization admin.
Queued work is cancelled if that authority is lost. Build logs require admin
access and personal access to every recorded source ID, checked together before
and after the log read. Before queueing a build, the server records each
repository's immutable GitHub ID separately from the public recipe. Failed and
partial builds retain those identities. A retained recipe never obtains a new
identity merely because its old owner/name now names another repository.
Reactivation and refresh carry the original IDs and pinned setup selection.
The clone uses the verified current canonical remote while its directory and
recipe path stay unchanged. Unknown legacy provenance blocks log access,
reactivation and automatic refresh; the logs and recipes remain stored.

An unverified legacy Computer recipe is an editable draft for a **fresh manual
build**, not evidence about any old source. An admin can save it or build the
configured revision with their current GitHub access; new immutable IDs are
recorded only on the new configuration and build. Active-build IDs are trusted
only under source policy v2; v1 targets never establish provenance. Verified IDs
remain pinned, and malformed verified provenance still fails closed. Recovery
starts from stock and never reuses the legacy snapshot. Creation and the repository picker
return `cloud_computer_rebuild_required` while that old build is active, directing
admins to Settings → Cloud Computer and other members to an organization admin.
Rebuilding does not verify or unlock historical logs, workspaces or checkpoints.

The builder also refreshes the snapshot without being asked. A new runtime pin
queues another clean image and validates the recipe on its disposable builder,
including Git and setup. A snapshot whose build recorded no runtime is
refreshed the same way. A refresh installs the runtime it was queued for, even
when a process still on the previous pin picks it up during a deploy.
An interrupted automatic runtime or daily refresh retries at most three total
attempts, with one-minute then five-minute delays. Each retry retains the
original recipe, source IDs, runtime digest and active-build/configuration
binding. The failed build and its log remain visible. A newer build or recipe,
lost administrator/source access, or unresolved provider operation prevents a
retry. Only a process using the recorded pin queues the retry; a queued retry
keeps that digest when a process on another pin claims it during a deploy.
Admission rechecks the binding after the drain wait and before provider intent.
The ordinary refresh scan cannot bypass an exhausted interruption budget.

Genuine automatic runtime failures retain their six-hour cooldown and limit of
three failures per pin. Daily refresh retains its ordinary daily schedule.
Failed manual builds and reactivations are never retried automatically. A
system cancellation of superseded retry intent does not permanently prevent
fresh automatic refreshes.

Builds and their cleanup hold their locks on a separate two-connection pool, so the
lifecycle's two database connections stay free. Once a day, an organization that used cloud workspaces in the last week is
rebuilt at its live build's refs when GitHub reports a moved branch; unbuilt
edits are left for an admin to build. An organization with no new commits is
not checked again for a day, one GitHub cannot answer for an hour, and
organizations are visited earliest-due first. An automatic refresh
is fenced to the live build it was scheduled from, so a build that became live
meanwhile is never relabelled or rolled back, and a rebuilt older build is never
refreshed this way. Scans run beside build admission, never ahead of it, every
ten minutes. A newly started process waits one interval before its first scan:
during a rolling deploy the old process still claims builds, and a build that
needs the new code would fail there. On Alpha (Computer v11, 2026-11-07) the
old process failed a source policy v3 refresh as `cloud_source_review_required`,
which also paused that organization's runtime refreshes for six hours. Each
lifecycle process runs one build at a time: a build holds a dedicated lock
connection for its whole run.

Control-plane shutdown closes build admission before waiting for work already
admitted. A claim that has not started a provider operation returns to the
queue; an admitted build continues with its heartbeat and cleanup. A stale
heartbeat alone cannot interrupt a build whose process still holds its lock.
After a process is lost, recovery resolves and cleans up its recorded provider
effects before queuing an eligible retry.

Runtime release controllers use the versioned database build drain described in
[Runtime release qualification](deployment-environments.md#runtime-release-qualification).
It blocks new claims, including older control-plane claim writers, and new
runtime handoffs while existing builds and committed handoffs finish. A release
may proceed only with an active, exact lease and zero live builds, unresolved
provider effects and committed runtime adoptions. Expiry or a confirmed release
restores admission. This drain never stops a user workspace or changes its
catalog state.

New workspaces start from the build they pinned at creation:

- **Creator can read every repository of a v3 build:** the scope records them
  all, and the VM starts from the build's snapshot. The other checkouts are
  removed before the worker or any agent can reach them, so agents cannot
  work on or push to them. Each one's Git data is deleted at once and its tree
  leaves its path in one rename. The files are deleted in the background,
  because thousands of them took 16.6 s on a restored disk. The image already
  holds the workspace's clone, so creation skips hydration: no token, binding
  read or detached command.
- **Anyone else:** the scope is the selected repository only. The VM starts
  from Boat's stock image with git-lfs, and the control plane clones only that
  repository.
- **v2 build:** the VM starts from its source-free snapshot and clones the
  selected repository.

Create checks the requested repository first, then the creator's access to the
other build repositories in order. The source authority verifies one repository
at a time per creator, and a denial invalidates the checks queued behind it, so
they never run together. The base branch is read while the others are checked.
Boat's detached commands (hydration and long setup) are polled after 250 ms,
backing off to every five seconds. Only a recorded exit status ends one; a poll
that times out or reads nothing keeps waiting until the command's deadline. The lifecycle logs `source_authorize` and
`repository_prepare` timings beside its other phases.

Restores after a lost disk apply the same rule to the active build and record
their choice, so a retried restore replays it without another lookup. The worker switches to the workspace
branch, creating it from the selected base only when absent; it never resets
an existing branch. Setup runs inside the individual workspace. Creation and
replacement-VM restore therefore need GitHub and can take longer; ordinary
wakes preserve the existing disk and installed dependencies. Runtime updates
continue to refresh automatically. The transition from legacy source-bearing
images requires the coordinated rebuild described below.

Repository authorization uses the immutable GitHub user ID and the exact
connection generation and verifies read or write permission as needed.
Cloud Computer builds use installation tokens for explicit repositories and
permissions when the App is selected. Workspace VMs use the creator's user token
as described below. Every configured source still needs separate authorization;
a shared recipe is not a credential grant. A confirmed positive for the exact
person, connection generation and repository ID is fresh for ten minutes.
Workspace admission and traffic start a background refresh two minutes before
expiry, sharing one verification for that person and repository. During a
GitHub outage or rate limit, connections, chat, files, terminal, history and
model proxy requests can reuse that positive for at most one hour from its
original confirmation. A person without a positive gets a retryable unavailable
answer. Failures never restart the confirmation clock. Git and GitHub network
tokens still verify repository access on demand; a write-only denial refuses
that operation without retiring the person's source-read authority.
Confirmed denial, disconnected
credentials, changed connection generations and unverified source IDs cannot
use grace. Organization membership, worker boot and app session checks still
apply independently.

The relay's 30-second transport heartbeat sends only socket pings; it does not
poll GitHub, login revisions or per-workspace database authority. Security and
login notifications invalidate observations, and actual traffic repairs missed
notifications and checks session expiry. Permission refreshes share a bounded
cache and one in-flight check per actor within a replica. Durable observations,
short compare-and-set claims and actor cooldowns coalesce replicas. Admissions
join an existing local verification or wait for the exact durable
claim, sharing one five-second wait budget across repositories and authority
reads. A fresh successful result can satisfy the waiter; a refusal or changed
authorization ends it. The worker's hello HTTP timeout is ten seconds. The
five-second verification budget leaves room for other configuration work, but
slow credential/configuration I/O can still exceed the hello timeout; the worker
retries that hello automatically. Waiters neither steal a live claim nor extend
source grace.
Lifecycle, hello and create checks use the same background refresh threshold.
A temporary refresh failure records its retry deadline while retaining the
original positive and its one-hour limit; a confirmed refusal withdraws it at
once.
Before that, the Create page warms the selected repository on intent: picking
or hovering it, or pointing at, focusing or typing in the prompt sends
`POST /v1/cloud-v2/organizations/:org/computer/repositories/warm`, at most
once per 10 seconds per repository. The route runs the create's member and
repository check with renewal and returns `{ ok: true }`; the desktop ignores
its result.
Transient failures back off from one to fifteen minutes, with bounded jitter, and respect
GitHub's longer retry delay. An idle workspace does not refresh GitHub access.
Relay close code `4001 access_revoked` means confirmed person access loss,
including membership, account, session or source denial. Context expiry,
temporary verification failure, workspace lifecycle changes and relay shutdown
use retryable code `1013`; a deployment does not declare that a person lost access.

Current authenticated worker activity records independently of GitHub, even
with the prompt outbox disabled, so an outage cannot make an active turn look
idle. Configuration refreshes can reuse the previously verified canonical
repository ID while applying current provider/MCP changes. Healthy source
verification also refreshes the canonical name and notifies the worker after a
rename or transfer, reusing the same GitHub response. Database timestamps keep
late responses from undoing a newer binding. Configuration refreshes never issue
GitHub tokens from stale evidence. Stop remains available. Grace expiry blocks
further protected requests with a retryable availability error; it is not
reported as an access revocation and does not delete work. A confirmed GitHub
denial withdraws the grant and initiates stopping.
Confirmed access loss stops a running workspace while retaining its disk and
checkpoint. Stop and Delete remain available for cleanup. Revocation does not
erase source or credentials already delivered to the VM; the VM remains one
trust domain.

## Testing a branch

[`pnpm electron:cloud`](electron-cloud.md) runs a branch's control plane, worker
runtime and desktop app together, with an isolated database and a named
tunnel for Boat VMs. Agents run it headless and then gate0 with `--local`.

## Application variables and environment files

Settings → Environment has separate Local and Cloud scopes for an organization.
The Local scope keeps the device's existing vault and file-copy policy. In Cloud,
choose a GitHub repository, then add application variables or select `.env` files
and their relative destination paths. Values are write-only: saved rows show
names, paths and sizes, and replacing a value requires entering it again. Switching
account, organization, repository or scope discards unsaved values and cancels
pending uploads. No Local vault values are uploaded implicitly.

Cloud defaults belong to the creator, organization and immutable GitHub repository
ID. Workspace creation pins one complete encrypted version atomically; edits or
clear-all affect future workspaces only. An existing workspace keeps its original
pin through wake and restore. A repository renamed at GitHub retains its identity;
a different repository at the old name cannot inherit its defaults. Concurrent
Settings edits use revision checks, so a stale save cannot replace a newer one.
Unreferenced versions are pruned after changes and workspace deletion; a bounded
ten-minute lifecycle sweep also releases pins left by older writers. Clearing
defaults retains a revision tombstone.

The limits are 128 variables, 128 bytes per name and 16 KiB per value; 16 UTF-8
files, 64 KiB per file; and 256 KiB for the complete selection including names and
paths. There are at most 128 repository scopes per creator and organization.
Values cannot contain NUL. Runtime, injection, Git, proxy and provider credential
names are refused, including `PATH`, `HOME`, `SHELL`, `NODE_OPTIONS`, `GH_*`,
`GIT_*`, `CLOUD_V2_*`, `ZEROS_*` and provider prefixes. A refusal never silently
shadows the selected login or changes the worker's own environment. Use
application-specific names for variables. Selected file contents are copied as
bytes and are not sourced into the worker process.

File destinations must be relative `.env` or `.env.*` paths, at most 512 bytes
and 16 components deep. Every destination must be untracked **and ignored by Git**.
Initial seeding refuses existing files, links, directories, private state and
nested repositories. It uses private mode-0600 files and no-overwrite publication
under the Git index lock; a durable journal records publication ownership without
file contents. A refusal leaves the workspace unavailable with recovery guidance.
Correct the defaults or repository ignore rules and create a new workspace.
After successful seeding, edits and deletions are preserved: wake does not copy the
original file over the current one. Encrypted checkpoints explicitly include the
bounded selected paths, including files beneath ignored directories and deletion
state. Restore retains edited bytes, file modes, reset/Undo refs and the seed journal.

In legacy and prepared workspaces, only the creator's pin is delivered, after current membership and GitHub source
authorization checks. Removing membership or disconnecting GitHub stops delivery
at the next configuration. Agents, setup and terminals receive application
variables as a separate child-process input; worker, broker, credential preflight
and generic Git commands do not. The shared Cloud Computer builder receives no
creator application environment. The VM remains the isolation boundary: agents
and terminals can read delivered variables and files. Known values and their
common escaped forms are redacted from worker diagnostics, setup logs and mirrored
history; checkpoint manifests contain metadata only. Encrypted checkpoints carry
the file bytes needed for recovery.

In a workspace shared for team sharing's "write as yourself" (activated, worker
feature `acting-user-v1`), each turn, terminal and setup runs from the lease of
the person it acts for. That person's environment files are never written into
the shared checkout: they live in `~/.zeros/contexts/<contextId>/env/`
(directories 0700, files 0600, their configured relative paths), named by
`ZEROS_PERSONAL_ENV_DIR`, with their `KEY=VALUE` pairs loaded under the person's
own variables. The agent is told in one line where they are. The directory is
erased when the context retires, after its processes are gone. The VM is still
one trust domain: other members' processes can read that directory, and the
person's variables, while the context lives.

Activated workspaces retain the VM when one person leaves, goes on Hold or loses
account or repository access. That person's contexts, tokens, pending prompts,
Mac connections and local-command bindings are revoked; other members keep
working. A session sign-out closes that session's clients and terminals while
already accepted turns retain their recorded sender. Commit and review identity,
GitHub, environment, MCP, API and Local commands come from each execution's person.
Local workspaces and legacy/prepared cloud workspaces keep their existing rules.

Every new activated turn uses the current workspace Creator's selected agent
login. Other members need no agent login or additional Pro subscription to send
a turn. The login owner is pinned separately from the sender: Reassign affects
the next turn, while a running turn and the same person's steer retain their
original login. Losing that pinned owner's membership, admission or selected
login stops the funded turns; the sender's terminals, files and Git remain usable.
An ordinary OAuth refresh, desktop sign-out or loss of the Creator's GitHub
access alone does not revoke another person's funded turn. Old contexts retain
their original login until they finish.

Missing Creator login returns `409 agent_login_required` with
`loginRequiredFrom: "self" | "creator"`. A missing or ineligible Creator returns
`409 workspace_creator_required`; non-agent operations remain available to
admitted members. There is no fallback to the sender's login. Capable workers
receive only a sparse `agentLogins` availability map for the current Creator,
fenced by `loginRevision`; actual credentials remain scoped to turn leases.

On channels with `ZEROS_CLOUD_TEAM_OWNERSHIP=1`, a Creator or organization
admin can reassign an activated workspace to another admitted member who has
access to every recorded source repository. Candidate agent-login availability
is presentation only: a member without a selected login is still eligible.
Reassign preserves the VM, running contexts, personal environment pins and
sender identity. The former Creator follows the workspace; the new Creator
does not follow their own workspace. Only subsequent turns select the new
Creator's agent login.

If the Creator leaves, goes on Hold or loses their account, the workspace has
no Creator until an admin reassigns it. Rejoining or regaining admission does
not restore ownership. Admitted members can still Start, Stop, use terminals,
edit files and use Git; agent turns return `409 workspace_creator_required`.
Account deletion retains these shared workspaces and erases the departed
person's private environment material. Legacy and prepared workspaces retain
their existing lifecycle rules.

Clients negotiate ownership documents with both `X-Zeros-Team-Sharing: 1`
and `X-Zeros-Team-Ownership: 1`. Those documents allow a null `creatorUserId`
and include `creatorRevision`, `noCreatorReason` and `canReassign`. The original
`createdByUserId` remains unchanged. Clients without the ownership header keep
their existing assigned documents; lists omit unassigned workspaces before
pagination and direct reads refuse with `409 team_ownership_required`.
`creator=none` is an admin-only list filter. Turning the channel switch off
disables ownership changes but keeps negotiated unassigned documents readable.

`GET /v1/cloud-v2/workspaces/:id/reassign-candidates` returns a bounded,
revision-bound page of members and their eligibility. `POST .../:id/reassign`
requires `requestId`, `toUserId`, `expectedCreatorUserId` and
`expectedCreatorRevision`. A changed Creator returns `409 creator_changed`.
Exact request retries replay their receipt for 30 days without repeating the
change; reusing the request ID with different input returns
`409 reassign_conflict`. Source verification and current membership are checked
again before committing. Neither a candidate list nor a receipt authorizes
future execution.

Direct sync on an activated workspace requires the exact boot to advertise both
`acting-user-v1` and `sync-context-v1`. Its signed grant includes a `ctx` client
handle bound to the person, session and Mac registration. The worker must renew
that handle after boot-clean and before opening a passive client or reading any
files. Renewals run every 10 seconds; push revocation, a refused renewal or the
lease deadline closes the sync socket with code 4001. Previously synced files
remain on the Mac. Legacy sync grants retain their original shape.

Deploy expand-only migration `0218_cloud_workspace_environment.sql` and the control
plane before publishing the worker runtime. The optional `environment` config is
negotiated by `workspace-environment-v1`; an old worker is refused when a workspace
has a required pin. Unpinned historical workspaces keep their prior behavior and
never acquire defaults retroactively. The hello response can deliver configuration
while a required-pin workspace is still starting. The worker durably seeds and
constructs required services, then reports the matching boot/version/sequence as
ready before publishing interactive services. A database guard prevents a rolled
back control plane's hello writer from bypassing this proof. Identical lost-response
report retries succeed, while stale boots and late failure reports cannot undo
readiness. Keep old encryption key versions available for pinned workspaces.

An organization admin can separately select a tracked Bash script in Cloud
Computer settings. Its workspace execution begins only after environment files
are durably seeded and the ready report is confirmed. Environment selection
alone never opts into repository code or private repository settings files.

## Workspace API, agent tools and resources

Workers advertising `workspace-api-v1` may receive an optional `api` field
(`https` base URL and a `zw2a_` workspace token) in their configuration. The
token is fixed for one VM run, so a repeated configuration changes nothing and
never respawns agents or shells. Agents receive `ZEROS_WORKSPACE_ID` and their
chat id as `ZEROS_SESSION_ID`; terminals receive `ZEROS_WORKSPACE_ID`. Only a
delivered `api` adds `ZEROS_API_URL` and `ZEROS_API_TOKEN`. Setup scripts get
none of them. The token is redacted like application values, including saved
terminal screens. `ZEROS_API_KEY` is the one `ZEROS_` name users may set.

The runtime ships `zeros cloud` (`/opt/zeros/worker/bin/zeros`, already first
on `PATH`), which prefers `ZEROS_API_KEY` over the token and explains when API
access is not enabled. Every agent execution receives the `zeros_workspace`
MCP server with read-only, size-bounded `GetTerminalOutput` and
`GetWorkspaceDiff` (the Changes view's All comparison); code review tools join
only while review is enabled, and Stop retires only grants that carry them.

`WORKSPACE_REQUEST` `workspace.resources` returns CPU, memory and disk usage,
sampled only when asked; workers advertise it with the `ENGINE_READY`
capability `workspace-resources-v1`. A memory watchdog reads `/proc/meminfo`
every second, and every 200 ms while available memory is under 15 %. Under 15 %
it raises unprotected descendants' `oom_score_adj` (restored once memory
recovers), so a kernel OOM kill that wins the race still picks one of them.
When available memory is below the larger of 5 % and 256 MiB on two consecutive
samples, it stops the largest one of at least 128 MiB, one every two seconds. It never signals the worker, its ancestors or direct children, the
runtime's agent CLIs or a login shell, and it reports what it stopped in the
owning chat or terminal. Local Personal and organization-local workspaces are
unchanged.

The worker's unit sets `OOMPolicy=continue`. systemd's default (`stop`) fails
the whole service when the kernel OOM-kills any process in its cgroup, which
ended every turn and terminal for one runaway child. The create and wake
installer writes the unit; running workers are never restarted for it and take
it at their next wake. A workspace cloned from a Cloud Computer snapshot built
before this unit pays one unit repair on its first boot, until that snapshot
is rebuilt for a newer runtime.

On the desktop, a cloud workspace's details popup shows Environment (Zeros
Cloud), Status with a Restart action (`POST /v1/cloud-v2/workspaces/:id/restart`)
for managers of a running workspace, and CPU, memory and disk. Usage is asked
only while the popup is open on a running workspace whose worker advertises
`workspace-resources-v1`, every five seconds; an older worker simply shows no
usage rows. Settings, General has a "Workspace API access" switch for each
cloud organization (`/v1/cloud-v2/organizations/:org/api-access`); it applies
to new workspaces and is hidden for the Local owner. A first API message can
name its chat: workers advertising `session-name-v1` take the delivery's
`sessionName` as the title only when that delivery creates the chat.
Workers advertising `chat-edit-v1` also receive `chatEdits` (title and/or
archived) on the prompt pull. After that reply's deliveries they apply each
edit to a chat they already have, once per version (recorded in the chat's
session file), leave `updatedAt` unchanged, and acknowledge it in the history
frame that carries the edited row. An edit for an unknown chat is not
acknowledged and is offered again; a version already applied is acknowledged
again without a change.

When the configuration carries `localCommands: 1`, workers advertising
`local-commands-v1` add `RunLocalCommand` to `zeros_workspace`: one shell
command on the Mac the chat's latest message came from, run by that person's
login shell only after they approve it in the app there (Always allow covers
only that default Mac). A local command is one-shot. The shell runs as its own
process group, and once it exits and its output closes the whole group is
ended, so a job started with `&` does not survive it. A background job that
keeps stdout or stderr open holds the command until its timeout; redirect it
(`>/dev/null 2>&1`) when it should not. Output above 32 000 characters is saved
under the checkout's `.context/local-commands/`.

When the configuration carries `notifyUser: 1`, workers advertising
`notify-user-v1` add `NotifyUser` (`title` up to 80 characters, `message` up to
280, `kind` review or blocked) to `zeros_workspace`: the agent asks for the
person at the end of a turn. The worker allows one per turn, sends it to
`POST /v2/cloud/worker/notifications` (202; 409 `already_notified` for a second
in the same turn; 429 past about 30 an hour) and a live `attention` session
update to attached apps; delivery never fails the turn. The control plane sends
a `notify` event on the device channel to every registered Mac of the chat's
latest desktop sender, kept for 10 minutes and never replayed. On the Mac, main
de-duplicates both paths by notification id, marks the chat unread, and raises a
macOS notification only when that chat is not on screen in a focused window:
the title is the chat's title and "needs you", the body only the agent's title
(a lock screen can show it); the message stays in the app. A click opens the
chat through the app's own link route. The transcript shows the call as
"Notified you: <title>". Local workspaces have no NotifyUser.

Sync to Mac (Order 3, worker feature `sync-v1`, `ENGINE_READY` capability
`workspace-sync-v1`) mirrors a cloud checkout one way into a folder on a Mac,
as a real Git clone. The person turns it on for This Mac in the details
popup's Connected Macs and picks an empty folder (or that workspace's earlier
sync folder) in a native panel; the path stays in Electron main on that Mac.
Main asks the control plane for a single-use `sync` grant
(`POST /v1/cloud-v2/workspaces/:id/sync/grant`, never wakes) and dials the
worker itself through Boat's protected route (`wss://<route>/v2/worker/sync`,
subprotocol `zeros.worker.sync.v1`, port-auth cookie and grant headers); no file
byte passes through the control plane. The worker accepts only a `sync` grant
there (a control grant is refused, and a sync grant is refused on the control
path), treats the socket as one passive client outside its census, admission
and activity, answers only `sync.snapshot`, `sync.read`, `sync.bootstrap` and
`sync.bundleRead`, sends it no broadcasts, and closes it unless it is renewed
with a fresh grant for the same user and device (`{ t: "renew" }`) within 10
minutes; main renews about every 8. Snapshots carry an epoch (new per boot,
checkout or watcher loss), a seq and the branch HEAD; an unknown epoch or a seq
older than the retained 2,000 batches gets a full inventory, paged from a
frozen copy. Tracked and unignored files only, never `.git`; symlinks only
inside the root; 100 MB per file, 5 GB (bundle included) or 200,000 files in
all. File bytes come by `sync.read` in 4 MiB chunks bound to the inventory's
sha256, one read in flight per Mac. History comes as a Git bundle of the branch
(full, or from the Mac's HEAD when that is an ancestor), chunked by
`sync.bundleRead`; the Mac's own git builds `.git`, sets the branch to the cloud
HEAD, `origin` to the credential-free remote URL and the index to HEAD, so
`git status` shows the cloud's uncommitted work as unstaged. Engine git runs
without hooks, credential helpers, fsmonitor or network transports and writes
no credential, URL rewrite or hook into `.git`. Git LFS is not handled: LFS
files show as modified. The Mac writes files through verified temp files and
renames, lstat-checks every parent, refuses traversal and case twins, commits
`.zeros-sync/state.json` per batch to resume, and only ever replaces or deletes
paths it wrote; a local edit it replaces is kept in `.zeros-sync/overwritten/`
(7 days, 500 MB). "Open terminal here" opens Terminal at the folder. Local
workspaces have no sync.

An opted-in Mac can request a GitHub credential for one sync command with
`POST /v1/cloud-v2/workspaces/:id/github-read-token` and body `{}`. The ordinary
desktop bearer, exact device/registration/instance headers, `X-Zeros-Sync: 1`
and `X-Zeros-Sync-Wanted: 1` are required. The Mac must still be connected with
sync wanted. The response is `{ token, expiresAt, repository }` and is never
cacheable. The token is an App installation credential restricted to the
workspace's immutable repository ID with `contents:read` and `metadata:read`.
`expiresAt` is GitHub's actual expiry, at most one hour; it is not a broker
cache deadline. The caller's own selected GitHub connection must prove current
repository access before and after minting. No Creator credential is borrowed,
and a personal OAuth token or PAT is never returned through this endpoint.
Missing access, a PAT selection or a missing eligible installation returns
`403 github_access_required` so the Mac can use the worker bundle. Transient
GitHub failures remain retryable.
Issuance is limited to 12 requests per minute per user/device across workspaces
and 120 per minute per user. It needs no running VM, creates no execution lease,
and changes no workspace activity. The Mac keeps the token in memory for its
Git command, never in Git configuration, arguments or files. VM Git and `gh`
continue to use their existing per-person broker path; Local is unchanged.

## Credentials and history

Settings → Agents stores encrypted logins in the control plane. The creator's
organization selection supplies Claude with `CLAUDE_CODE_OAUTH_TOKEN` or
`ANTHROPIC_API_KEY`, and Cursor with `CURSOR_API_KEY`, directly in the VM.
Codex calls `/v2/cloud/proxy/openai/*` with a workspace proxy token;
the upstream credential and ChatGPT renewal stay in the control plane.
Each child receives only its own login through a shared environment allowlist.
Config refreshes replace the entire configuration; idle drivers reopen as
needed, while active turns keep their spawn-time credentials. Git and `gh`
request credentials from the creator's selected cloud GitHub connection through
the worker's broker. With the GitHub App selected, both receive the creator's
user-to-server token. It can reach **every repository the user and the App can
access**, beyond the workspace's pinned repository. With PAT selected, both
receive that PAT with its existing scopes. Create-time hydration and checkpoint
restore use the same human credential; the shared Cloud Computer builder keeps
its installation credential. The **VM is the isolation boundary**: every process
there, including other agent sessions, can use a delivered token. Broker caching
is bounded to two minutes; it does not shorten the credential's GitHub lifetime
or reduce its scopes.
The broker shares concurrent requests and keeps a successful token until ten
seconds before that two-minute lease expires. An unchanged configuration
refresh preserves both the cache and any active request. A changed login
revision, transport disconnect or refusal withdraws cached material. Recovery
and one delayed retry of a transient credential failure share the caller's
original twenty-second deadline; each HTTP attempt gets at most fifteen
seconds of the remaining budget. A fixed `GET /user` checks a new token and,
after success, checks that same token at most once per three minutes; concurrent
callers share the check. Each check uses at most three seconds while reserving
time for handoff. Only a definitive 401 blocks the credential. Network failures,
timeouts and other HTTP responses hand it through unverified and defer another
check of that hash for one minute, so REST availability and quota do not block
Git. Control-plane/source refusals, token expiry and connection changes still
prevent handoff. A 401 reports only the used token's SHA-256, expires that exact credential
version, joins the existing refresh lease and retries the authentication read
once. A late report cannot expire a replacement token. PAT rejection requires
reconnection. Git's credential-helper `erase` and `gh`'s HTTP 401 report repair a
rejection between validations. If a command already ran, its original exit code
is retained and the repaired token serves the next invocation: Git and `gh`
commands are never replayed, even if a later step failed after a successful write.
Connection, installation, SSO, access, source-review and rate-limit
refusals reach Git/`gh` stderr as bounded recovery guidance; control-plane logs
record only a closed reason and cause class, never provider text or credentials.

Each worker instance publishes its own Unix socket through
`GH_ZEROS_BROKER_SOCKET`, in a private temporary directory outside checkpointed
session state. The directory is mode `0700` and the socket is mode `0600`.
Helpers accept only `/tmp/zeros-github-<lowercase UUID v4>/github.sock` and reject
all other environment-supplied paths before dialing, including trailing newlines.
Startup refuses an existing pathname, and disposal removes only the socket
inode that instance created. Cleanup captures the directory entry under a
private name before rechecking ownership; a foreign capture is restored without
overwriting any newer publication, and its private alias is retained.
The listener binds through a temporary name so
native close cannot unlink a replacement at the published path. Helpers retry
a missing or refused socket connection once after 250 ms, only before sending
the request; both dials and response reading share one 21-second deadline.
Clean Cloud Computer snapshots are captured before any configured broker starts.

Deploy the control plane before publishing the new pinned runtime. Older workers
receive user credentials even when they omit `purpose`. The `github-user-token-v1`
feature gates the optional recovery configuration and rejected-token digest.
Against the previous control plane a new worker requests its existing human
`gh` purpose for both tools and sends no unsupported fields. It refuses an
unchanged rejected token when forced refresh is unavailable. Pre-worker hydration
and restore adopt the user-token policy when the control plane is upgraded.

Before checkout setup, agents, terminals or Changes commits are admitted, the
worker installs the creator's Git identity from the selected organization
connection. The name is the GitHub profile name, falling back to the verified
login; the email is `<github_user_id>+<github_login>@users.noreply.github.com`.
During a temporary profile lookup outage, the selected connection's stored
login is used after rechecking its authorization generation. A profile that
the same control-plane process read for the same token within the last 30 s
(for example, during that hello's source check or the create's branch lookup)
is reused instead of calling GitHub again. The authorization generation is
still rechecked.
Activated workspace leases use the person's already-confirmed profile or the
selected connection's stored identity without a GitHub request. This remains
available when the Git token needs renewal; network operations still obtain a
separately verified token. The current database authority is checked before any
material is returned.
The VM user's global Git config includes the worker-owned
`~/.config/zeros/git-identity`, which also sets `user.useConfigOnly=true`.
Confirmed configuration changes atomically replace that file, so existing
shells see the new default. An explicit disconnected configuration clears the
managed name/email; commits without an explicit identity fail and Changes
offers reconnect guidance. Deliberate repository-local identities, including
those on restored checkpoints, retain Git's normal precedence and are never
rewritten or cleared. Wake, restore and reconnect reapply the managed default
before new work. Both HTTPS and relay configuration negotiate `git-identity-v1`:
older workers receive no extra field, and an older control plane's omitted
field leaves the existing Git configuration alone. Local Git identity and
credential behavior are unchanged.

Control-plane clone commands receive their one-command authorization header
through a private Boat file upload, opened and unlinked before execution, then
passed on stdin. Git reads it through an environment reference. Neither the
token nor its encoded header belongs in command arguments, remote URLs,
transcripts or logs. This protects command metadata, not other processes
already running with the same VM permissions.

Provider readiness and new-turn admission use the same worker verdict. An
expired Codex proxy grant makes the provider unavailable until renewed config
arrives; it does not prove the upstream account needs a new sign-in. Reattaching
to a turn already running keeps that turn and its original credentials. The
next native turn is refused until usable credentials arrive. Local provider probes and
their recovery behavior are unchanged.

Customize stores organization MCP definitions separately from provider logins.
Definitions can be organization-shared or private to one member and can target
all repositories or one admitted GitHub `owner/repo`. The control plane
encrypts variable/header/client-secret values, OAuth attempts and per-user
grants; edits use definition revisions and recheck membership, role and
repository admission. New scoped definitions record the repository's immutable
GitHub ID from the selected cloud connection or refreshed native admission.
Cloud workers resolve scoped definitions by their original source ID, so a
transfer retains tools and a replacement at the old name receives no secrets.
Name-only legacy definitions remain stored and keep their Local compatibility;
an authorized editor must save them with verified repository access before they
can be delivered to cloud. The server never backfills them from today's names.
Each member authorizes their own account for a shared
OAuth definition. A denied provider callback settles the attempt immediately.
OAuth discovery honors the resource's advertised protected-resource metadata.

Cloud configuration includes optional MCP definitions only for workers
advertising `mcp: 1`. Older workers refuse MCP-enabled admission instead of
silently omitting the tools. The worker launches STDIO on demand and fronts
HTTP/SSE with an SDK-backed loopback gateway. Claude, Codex and Cursor receive
gateway capabilities rather than upstream authorization headers. Credential
refresh is demand-driven, bounded and shared by the definition; cancelling one
client stops that client's wait without cancelling another live client.
Definition/login revisions invalidate cached authorization and provider reuse.
Runtime removal or shutdown closes the gateway and its owned processes.

An MCP failure retains its server ID and a bounded reason: sign-in required,
access refused, server error or unreachable. Only the native execution that
requested it receives the durable warning; repeated handshakes share one
warning per reason until the driver is replaced. The transcript's Connect or
Retry action opens that server in the owning organization's Customize page.
Account, owner and execution changes retire stale actions and late failures.
An optional Streamable HTTP GET/DELETE returning 405 leaves POST calls usable.

Organization-owned Local workspaces resolve the same definitions through
Electron's private account-bound broker. Native GitHub admission refreshes on
demand; generation and exact-child checks reject late credentials after account
or engine replacement. Personal Local workspaces remain independent of these
cloud APIs and keep their device settings and encrypted native vault.
See [MCP configuration](extension-discovery.md) for the editor and Local
compatibility contracts. The VM remains the cloud credential trust boundary.

For an OpenAI API key, the control plane reads that key's `/v1/models` list
through the existing vault selection and workspace proxy authorization. It
caches complete model IDs per credential for five minutes (unknown results for
30 seconds); the worker keeps a 30-second cache fenced by the login revision.
The cloud model menu leaves unavailable Codex models visible but disabled,
including when another agent is selected. Opening the menu revalidates metadata
without waiting to display it or starting a provider turn. Failed discovery is
unknown, not an empty account list. ChatGPT discovery stays unchanged.
Model-access refusals show the selected model and an action to choose another;
provider project IDs, proxy URLs and request IDs remain diagnostic-only. Neither
discovery nor a refusal automatically changes the saved model or retries a turn.

Provider failures retain a bounded category through startup replies, prompt
receipts and mirrored transcript notices: rejected credentials, account
verification, unavailable cloud credentials, usage/rate limit, missing native
session, unavailable model or unavailable provider. Public text comes from the
category, never raw provider diagnostics. A confirmed Retry-After deadline is
retained without its headers. The transcript offers the corresponding account,
model, later retry or new-session action, with no automatic prompt resend.
An absent worker execution remains an ordinary adoption miss; it cannot claim
that a native provider conversation was deleted.

Cloud Claude and Codex questions use the same cards and native answer mappings
as Local. Pending questions and Plan approvals belong to the worker execution:
closing or reconnecting the app does not dismiss them. The worker saves the
request before showing it, replays it on reconnect, and retains the answer or
dismissal in mirrored history. Secret answers reach the native agent but are
hidden in the saved answer and settlement broadcast. A worker restart retains
the dismissal, without restoring a native resolver or replaying the turn.

Plan and Full access use each agent's native modes. Cloud exposes the existing
controls only when the session advertises them, after both carriers negotiate
`agent-interactions-v1` and `agentInteractions: 1`. Claude supports native plan
approval; Codex uses Local's read-only policy and native permission requests.
Cursor supports its native Plan mode and keeps Local's current lack of question
response support. MCP elicitations remain unsupported in cloud. Older peers
retain cancellation notices and do not advertise Plan controls.

Claude can ask questions in Full access in both Local and cloud workspaces.
The headless runtime receives a stdio permission-prompt channel and an
`AskUserQuestion`-only hook; ordinary Full access tools still run without
permission prompts. Human answers use the existing question cards. Dismissal,
failed delivery, expiry or execution retirement denies the native question.
Older cloud peers without interaction support receive neither the channel nor
the hook. Gated modes retain their existing permission callbacks.

Approving a Claude plan is `allow_once` for `ExitPlanMode`, as in Local. It does
not approve subsequent tool calls in that native run: Claude exits Plan into
its default permission mode, and the next Write can ask for a separate approval.

When only a question or approval is blocking the turn, the worker reports idle;
independent tools, background tasks, terminals, setup and file transfers still
count as work. An unanswered cloud input expires 15 minutes after it was asked
(Local keeps its 30-minute response timeout). A blocking expiry stops the turn
and cancels queued durable prompts through the existing conversation Stop epoch,
so the pending outbox cannot keep the VM awake indefinitely. History records
“dismissed after 15 minutes without an answer”; workspace shutdown records
“dismissed when the workspace stopped”. A nonblocking question expiry dismisses
only that question.

Durable HTTP prompts freeze optional `permissionMode: "plan" | "bypass"` with
model and effort before attachment or network I/O. The worker applies it only
when dispatching that prompt; a steer with a different mode queues. Explicit
Plan requests fail on unsupported peers instead of running with full access.
Legacy full-access sends omit the optional field until support is known.

Provider failure categories ship in the SHA-pinned worker runtime and desktop.
Their optional `cloud` metadata is nested inside the existing bridge
failure/notice payloads and serialized history rows. Old desktops accept these
messages and keep the sanitized fallback text, while new desktops accept old
records without metadata. No protocol bump or database migration is required.
The outbox's control-plane
receipt still reports delivery state only; the durable transcript supplies the
provider reason.

The worker folds native streams through the shared `applyUpdate` reducer and
persists chat/session state under `/home/user/.local/share/zeros/cloud-worker`.
It mirrors chat metadata, deletions and message rows to the control plane.
The app can read that history while the VM sleeps. This history mirror is
separate from repository files; there is no Mac checkout synchronization.

Chat search uses the connected worker when available and the HTTP history
mirror while the VM sleeps, without waking it. Search is scoped to the selected
workspace or conversation. Local, the worker and the mirror share literal
whitespace-separated AND terms, text-before-tool-title extraction and SQLite
FTS5 matching, including punctuation phrases and accent folding. The worker
and control plane build disposable in-memory indexes with Node's built-in
SQLite; no index or search state is persisted. Current Node 24 worker and
Node 22 control-plane images supply that runtime module.

Cloud search allows at most 4,096 query characters, 64 terms, 50,000 history
rows and 16 MiB of payloads under one five-second budget. It returns up to 50
ranked hits by default (500 maximum), bounded to 8 MiB of serialized results.
An oversized corpus or unreturnable single result produces `SEARCH_LIMIT`
instead of an empty or partially searched corpus. Narrow the search to a
conversation. Mirror reads hold one repeatable-read snapshot across scan and
payload fetches, exclude deleted chats and retain creator authorization.

Cloud Git supports soft, mixed and confirmed hard reset, plus literal-path
restore from a ref (including the index unless `staged: false`). Local retains
its Design guards and uses the same validators and argument builders. Full
branch lists and repository catalogs preserve full ref names, including names
that collide with tags. Only the worker's own checkout maps to a cloud
navigation destination; another VM worktree has no app route. Ordinary catalog
reads remain passive. An explicit catalog fetch uses the checkout mutation
queue, counts as activity and has an eight-second fetch budget plus at most
five seconds to resolve the remote default branch.

For new Git-backed turns, the worker captures pre/post trees through a scratch
index and hidden `refs/zeros/turns/` refs. It intersects the native tool paths
with that disk comparison, so denied edits, unchanged files and unrelated
paths do not become turn changes. Claude, Codex and Cursor use the same path
attribution as Local, through the shared protocol package; the worker still
does not import the Local engine. Staging and the checked-out branch stay intact.
Background completion serializes with the first terminal capture, and saved
comparisons and chat deletion refresh connected Changes views. Deleting a chat releases
its snapshot refs; oversized aggregate patches return file metadata so Review
can still list and select individual files.
Turn records and snapshot IDs stay on the VM. An optional `turnSummary` on the
opening user message mirrors the file counts and timing without native paths
or snapshot IDs. Each changed summary advances the opening's existing
`updatedAt` stamp, including same-millisecond background captures and clock
corrections. Imports and prompt replay retain the worker-owned summary and its
stamp. A newer mirror stamp can therefore recover a lost live summary update;
an opening without a stamp uses its creation time as the freshness baseline.

The footer renders the mirrored summary without connecting to the worker.
Explicit Review opens Changes with that exact turn range; file clicks read
the recorded diff through `turns.diff`. Cloud hover/focus does not prefetch a
diff or wake the VM. These reads require a worker runtime containing turn
recording, installed on create or wake; older turns without snapshots do not
gain a reconstructed comparison. Older workers may still refuse `turns.list`,
which the renderer treats as unavailable history.

Reset uses the same authored-path inverse and conflict rules as Local. It can
restore files, cut the transcript, or do both. It preserves unrelated edits and
staging; overlapping edits and unavailable snapshots are reported without
overwriting those files. Cloud holds Git's index lock through file and matching
staged-entry publication: newer staging stays intact, and a refused file change
does not change the index. Reset first retires the conversation's native execution
and confirms its HTTP Stop epoch, then waits for receipts before applying the
cut. New prompts wait outside the mutation. A transcript cut clears the saved
provider continuation, so the next prompt starts with the retained history.
Cloud Edit and send submits nothing if the cut is refused or its outcome is
uncertain. Account, owner, peer and Stop changes cancel the pending action.
Inbox shutdown cancels waiting admission; workspace Stop retires all native
executions before waiting for those deliveries or mutations to settle.

Transcript changes require the negotiated `history-replace-v1` feature and
`historyReplacement: 1` configuration. The worker sends an ordered replacement,
including an empty cut, with `historyState { revision, beforeEpoch? }`. The control
plane stores that state atomically with the replacement in the existing chat
row and reads rows and state from one snapshot. Renderer caches keep the exact
chat revision, reject older mirrors, and hide only receipt-only bubbles from
before the cut's Stop epoch. Canonical rows restored by Undo and new-epoch
prompts remain visible. Older peers retain their original history format and
refuse transcript mutations; a worker with a persisted cut does not resume
additive mirroring after a capability downgrade.

The last five resets retain Undo records. Undo merges file restoration around
later edits and restores the transcript only while its cut revision and
continuation are unchanged. Turn trees and retained reset trees are pinned by
one private Git ref per retained tree, including trees reused across resets.
Encrypted checkpoints carry those trees alongside worker
session state, so recorded diffs and an eligible Undo survive replacement of
the VM. Restoring private refs never follows a symbolic ref into a user branch.
Local Personal and organization-local reset entry points, storage and permission
behavior remain unchanged.

## Cloud GitHub connections and pull requests

Settings → Integrations offers **Zeros GitHub App** and **Personal Access
Token** for each person's selected organization. Both credentials can be saved;
only the explicitly selected method is used. Connecting, selecting, replacing
or disconnecting one method never imports a Mac login, borrows an administrator's
connection, or silently switches to the other method. Local Personal and
organization-local connections keep their existing native vault and behavior.

GitHub sign-in identifies the human by GitHub's immutable user ID. The Zeros
account email establishes no GitHub permissions. App access is the intersection
of that human's repository rights and the App installation's selected
repositories and permissions. A PAT uses its own GitHub scopes, selected
repositories, organization approval and SSO restrictions. Prefer a fine-grained
PAT with only the repositories and permissions the workspace needs. Repository
lists omit undiscoverable repositories and label entries without push rights as
read only. GitHub may intentionally return the same refusal for a missing
repository and one the caller cannot access; Zeros does not infer which it is.

The control plane encrypts credentials with its versioned vault keyring.
OAuth uses a single-use, ten-minute state and PKCE. App-token renewal uses a
durable lease: an ambiguous refresh is not replayed with a potentially consumed
refresh token. Another control-plane replica waits up to ten seconds for the
current lease owner to finish, rechecking the connection generation on every
read; it never steals or replays an expired lease. Reconnect starts a new
generation. Every operation checks the
selected connection, account and organization membership; late callbacks,
credential requests and responses cannot restore an earlier generation.
Renderer snapshots contain connection health and the GitHub login, never
saved credential material. Disconnect withdraws future broker access; it does
not revoke copies already delivered to the VM at GitHub. Revoking such a
credential requires GitHub's own token/App authorization controls.

New workspaces record the immutable repository ID from the selected build's
server-owned provenance. Creation rechecks this mapping under the same lock
that pins the active build; a second lookup of the mutable name cannot replace
it. The installed-repository picker shows the current canonical name while
checkout, default branch and setup retain the original recipe binding. All
later source checks retain the original source ledger and resolve its pinned IDs.
A verified rename or transfer updates the displayed canonical name, GitHub
links and eligible `origin` fetch/push URLs. The checkout path, workspace ID,
working files, staged changes and original source scope stay intact. Custom
fork destinations, URL rewrites and concurrent Git configuration edits are
preserved. A reused old `owner/name` cannot redirect PR or source operations
to a different repository. Moving to another repository is a separate explicit
selection; it is not a transfer of the original ID.

Organization MCP settings retain **On this Mac** as their default repository
connection. Selecting **Cloud** explicitly uses the saved cloud method and its
repository catalog. A restore onto a newer clean Computer never runs setup
from a different repository that reused an original source name.

Once the worker has reported its checkout and the source scope is authorized,
the workspace advertises `githubPullRequests: 1`. Published PR discovery,
status, checks, commits, reviews, diff and inline discussions use authenticated
HTTPS to the control plane. These reads also work while the VM is stopped.
Private workspace comments use the VM's bounded `review.sqlite` store after
`code-review-v1` negotiation. They share Local's comment API and four agent MCP
tools, persist through encrypted checkpoint restore, and never publish to
GitHub. A stopped VM shows the existing open-to-view state without a passive
wake. See [Workspace code review](code-review.md) for limits, attribution and
grant lifetime. A GitHub reply or line comment is explicitly posted to the PR
and never written to Local SQLite.

Create PR requires a running checkout. The primary action gives the agent a
branch-specific instruction using the selected cloud connection, and refreshes
discovery when that turn settles. The brief pins both its HTTPS push URL and
`gh --repo` target to the freshly verified canonical repository; a stale or
custom Git remote cannot replace it. Connection/branch changes while gathering
Git facts require a refresh before the brief can be sent. The manual compare
link uses the same verified identity. Local briefs and compare links retain
their configured remote behavior. Direct creation uses the existing explicit
commit-and-publish flow, then creates or adopts the exact repository/head/base
PR. Both paths publish to the canonical repository. Cross-repository fork PRs
are outside this implementation. HTTPS public actions and `gh` use the human's
credential, so they are attributed to that GitHub account; a Git installation
token does not impersonate the human as a PR author.

Ready, edit, close/reopen, merge, comment, reply and resolve actions revalidate
the connection, immutable repository, PR and displayed head/base revisions.
GitHub enforces operation permissions, branch protection, required checks and
reviews. A successful public write stays a successful outcome if its following
metadata refresh fails. Connection, repository and branch changes retire
protected PR/review caches and drafts, including switching away and back;
hidden surfaces stop discovery, checks and review polling.

An unavailable workspace keeps its recovery controls. Its PR surface explains
whether to connect/reconnect GitHub, grant the App repository access, authorize
SSO, check the selected account's rights, retry a provider failure, or review
historical source provenance. Withheld PR data is not replaced by a stale
cached discussion. A denied repository is never made accessible merely by
belonging to its Zeros organization.

## Numbers and titles

Every cloud workspace is `w-<n>` within its organization (migration 0225). A
`BEFORE INSERT` trigger takes the next number from the organization's
`cloud_v2_workspace_number_sequences` row, under that row's lock, so concurrent
creates get distinct numbers and a release that predates numbers is numbered
too. Numbers are never reused: the sequence outlives deleted and purged rows.
A workspace is "Untitled" (`title` NULL) until one of its chats is first named;
the history mirror then copies that chat's title onto the workspace once and
advances `updated_at`, so clients replace their document. The desktop re-reads
the document a few bounded times after it names a cloud chat instead of waiting
for the catalog's 30-second refresh. The sidebar shows the title; the column
header shows the cloud, then `w-<n>`.

### Organization IDs

An organization's ID (its `slug`) is the owner segment of its workspace pages
and links. Its display name can change; its ID cannot (`PATCH` with a `slug`
answers `422 organization_id_immutable`). Display names may repeat; IDs never
do, deleted organizations' included. At creation the control plane tries the
display name's own ID (lowercase ASCII letters and digits in hyphen-joined runs,
at most 40 characters, cut on a word boundary), then that ID with `-org`. It
skips IDs a workspace page cannot use (`organization-slugs.ts`, mirrored by
`RESERVED_WORKSPACE_LINK_OWNERS`: web routes, Local's own `local` owner and
link actions), so `Local` becomes `local-org`. When every candidate is taken
it answers `409 organization_id_required` and the creator chooses the ID; a
chosen ID that is taken answers `409 organization_id_taken`. Personal
organizations keep their longer `personal-<id>` IDs, which no new organization
can choose.

The web dashboard's create form shows the generated ID under the name as it is
typed (`GET /v1/organizations/id-availability?name=`, Pro only, rate-limited)
and lets the creator edit it (`?id=` checks an edited ID). Creating waits for
the answer for exactly the current name and sends the ID the field then shows;
when every candidate is taken it asks for an ID instead of creating, and when
the check fails it sends none, so the control plane generates it the same way.
A control plane that predates chosen IDs ignores one; the dashboard then names
the ID it created. General shows the ID read-only, beside the organization's
internal UUID.

## Web page and desktop link

`app.zeros.build/<organization ID>/w/<n>` is a cloud workspace's shareable
page, and `?session=<chat id>` names a chat in it. The page reads nothing and
needs no browser sign-in: it opens
`zeros[-alpha|-beta|-dev]://<organization ID>/w/<n>[?session=<chat id>]` with
the deployment's scheme as soon as it loads, and keeps Open in Zeros for a
browser that asks first or blocks the launch
([`local-orchestration.ts`](../packages/protocol/src/local-orchestration.ts)
formats the link; a root test keeps the web's copy equal). A malformed or
repeated `session` is a 404. The older `app.zeros.build/workspace/<id>` page is
still served: it signs in, reads `GET /v1/cloud-v2/workspaces/<id>` through the
web's control-plane proxy (which admits only that read), shows the workspace,
and opens `zeros[-alpha|-beta|-dev]://cloud-workspace/<organizationId>/<workspaceId>`
once ([`cloud-workspace-link.ts`](../packages/protocol/src/cloud-workspace-link.ts)),
the link every desktop release opens.

Neither link carries a secret or grants anything. Electron main accepts only its
channel's scheme and passes the link on the navigation intent Local links use,
so it opens a window and waits for the signed-in app. A local development build
ignores a `cloud-workspace/` link; a numbered link reaches its renderer, which
says when cloud workspaces aren't available. A numbered link whose owner is not
`local` is a cloud link (`isCloudNavigationLink`). The desktop finds the
organization by its ID among the account's organizations, finds the workspace
by number in the loaded catalog or with
`GET /v1/cloud-v2/workspaces/by-number/<organization ID>/<n>` (creator-only,
like the read by id), reads it by id, switches to its organization and opens it
as the sidebar does, except that a link never starts it: anyone can send a link,
and numbers are easy to guess. A stopped workspace shows its history and starts
on the first click or key inside it, as a restored tab does; an archived one
opens read-only. An organization the account is not in, a 404 or a deleting
workspace shows an error toast, and nothing switches.

A chat link then selects its chat in the same store update that loads the
workspace's chats, before the pane picks one, and waits at most 30 seconds. A
chat the loaded list lacks, or one that is archived or a terminal, shows an
error toast in the workspace that opened. Leaving that workspace, or any newer
link, ends the wait quietly, so a chat link can never select over a later
navigation. Desktop releases before numbered links ignore a numbered cloud link.

A cloud workspace's context menu has Copy link, which copies the
`/<organization ID>/w/<n>` page for the build's web app (`VITE_APP_BASE_URL`),
or the id page while the number or the organization's ID is not known. A cloud
chat tab's Copy link copies `/<organization ID>/w/<n>?session=<chat id>`, and
only appears when both are known. There is no invite route: cloud workspaces
are creator-only.

## Lifecycle

Each lifecycle replica admits up to four workspace steps concurrently and
excludes its in-flight workspaces from further claims. Creates, wakes and
deletions are claimed first. Stops can spend minutes saving a checkpoint, so
they use at most two of the slots, and a slow stop never holds up another
workspace's creation. Running VMs receive a 24-hour Boat
lease; a bounded background scan renews it after about 12 hours.

The loop sweeps every 2 seconds only while it has work in flight. Otherwise it
sleeps until the next deferred step falls due, at most a minute. Database
triggers notify `zeros_cloud_v2_lifecycle` when a workspace enters `creating`,
`starting`, `stopping` or `deleting`, a prompt asks to wake a stopped
workspace, or a Cloud Computer build changes, and each notice starts a sweep
at once. Reconnecting the shared LISTEN session sweeps once, covering notices
lost meanwhile. Idle stops and other time-based scans run within that minute.

The lifecycle loop stops a running VM after 20 minutes without activity
(`CLOUD_V2_IDLE_STOP_MS`), like Conductor's sandboxes. These count as activity:
- turns, workspace setup and attachment transfers;
- terminal input and output, file saves and Git mutations, each for one minute
  afterwards (`RECENT_ACTIVITY_MS`, one report heartbeat);
- a focused, visible Zeros window showing the running workspace. The app posts
  `/activity` at most once a minute; the post never wakes a stopped VM, and
  the store records it at most every 30 seconds.

A VM therefore stops about 20 minutes after the last of these. There is no
maximum lifetime: running VMs renew their Boat lease every 12 hours. Reads and
polls do not renew it; an untouched shell eventually becomes idle. Passive history reads do not wake
the VM, and neither do reconnects: `/connect` accepts `{ "wake": false }`, and
the single-use ticket carries that intent through bridge admission. The app
asks to wake for explicit navigation from the sidebar, Dashboard or repository
rows, an Open in Zeros link from the workspace's web page, or a trusted pointer
press or keystroke inside the active cloud workspace.
This includes empty space, the composer and the Files editor. There is no wake
notice; a save joins a pending wake before dispatch. Without a pending wake, a
save against a stopped workspace rejects as a temporary transport failure so its
draft can be retained and retried. Hover, metadata restoration, polling, hidden
tabs and autosave retries do not create wake intents. Stop, archive and delete
cancel earlier input intents; input cannot reverse a shutdown in progress or
restore an archived workspace. Owner/account changes cancel the old surface's
intent. Local workspaces keep their existing behavior.

New desktops add `wakePolicy=explicit` to the connect URL and offer the
`zeros.cloud.v2.explicit-wake` WebSocket subprotocol alongside the existing
protocol and ticket. The HTTP request owns the stopped-to-starting transition;
the opted-in relay only joins an existing start or running worker. A transient
worker disconnect redials while the workspace is still running, keeping the app
attached so output resumes. It closes the app socket with
`4009 / workspace_not_running` when admission or redial confirms a stopped,
stopping or archived workspace. Queued reads,
saves and old wake tickets cannot start compute. The desktop rejects pending
work as a transport failure and lets fresh user input acquire the next wake.
The connect transition atomically requires an unarchived workspace, so an
archive committed during source authorization cannot be undone by that request.

Older callers retain the existing default when `wake` is absent, and their
bridge traffic can still wake stopped compute. An older relay selects the base
protocol when a new desktop offers both; it retains that legacy behavior.
Start remains explicit. Stop retains the VM disk and saves a checkpoint;
Delete removes the VM, its checkpoints and its access. Account and organization
deletion also enqueue their workspaces for cleanup.

An initial create response that arrives after deletion still records its exact
VM for cleanup, before any runtime installation, repository hydration, protected
route or credential delivery. A completed deletion returns to `deleting` for
that VM; provider failures retain it for retry. Cleanup completion and errors
are fenced by the observed VM, so an earlier deletion that saw no VM cannot
discard the late cleanup. A newer stop, restore or assigned VM fences out an
old initial response. Lost create replies and process exits before recording
the response still require reconciliation; this path does not rediscover VMs
by their short display names.

Roll out the control-plane negotiation before the desktop to enforce the
background-wake rule. The mutation-activity change also requires publishing and
selecting the updated SHA-pinned worker runtime; create/wake installs it, so an
already-running VM adopts it on its next wake. No schema migration is needed.
Quitting the Mac app still leaves cloud agents and terminals running, while
Local quit retains its existing stop behavior.

A VM stop ends its shells, so the worker keeps what a plain terminal needs to
come back. The desktop marks a cloud shell restorable (`PTY_CREATE.restore`)
only when it has no Run, setup or agent launch; those must start again. For a
restorable shell the worker writes its screen snapshot and live directory to
`terminals/` in its private state, two seconds after output and at shutdown.
After a wake, runtime update or app restart, the next create for that id
starts a new shell in that directory and replies as a reattach carrying the
saved screen. If the directory is gone or outside the checkout, the shell starts
at the checkout root. A shell that exits or is closed drops its record. Records
expire after seven days, and at most 64 are kept. Local terminals are unchanged.

A new workspace branch starts from the authorized checkout hydrated into its
own VM before worker startup. Before persisting a new workspace or allocating a
VM, creation checks the requested branch (or the build's recorded default)
with the creator's selected GitHub connection against the admitted repository
ID. A tag or commit with the same spelling is not a branch. A confirmed miss
returns `repository_branch_not_found`; rate limits, outages and connection
changes retain their own errors.

A create can return before those GitHub checks. The control plane then
persists the row in `creating` with `source_pending`, and checks only the
database:
- membership, Pro and member holds;
- the active Computer;
- a recipe entry with the requested name;
- the base branch.

The lifecycle's first creating step runs the checks above, in the same order
and as the creator, before any VM exists. It then sets the source scope once.
The database refuses a sandbox, or any other scope change, while
`source_pending` is set.
- A refused repository fails the workspace with `cloud_source_access_denied`.
- A missing branch fails it with `repository_branch_not_found`.
- A rebuilt Computer fails it with `cloud_computer_changed`.
- Outages retry with the lifecycle's backoff.

Until then, routes that hold only the creator's own data skip the source check:
connect tickets, the prompt outbox, history and creation receipts. Documents
show a plain creating row. The relay admits the app and checks again within a
second. Every other source check refuses `cloud_source_pending`.

Runtime canaries stay synchronous, and so do names that match no recipe entry,
such as a renamed repository: only GitHub can map those. A new replica returns
creates early only after one lifecycle scan interval (10 minutes; none on the
development channel), so a draining replica never sees a pending row. At creation the control plane records GitHub's
head of the base branch. Workers advertising
`checkout-v2` receive it as `baseCommit` and start the branch there when the
VM has that commit; otherwise the branch starts from the cached
`origin/<baseBranch>`. The worker then fetches `origin` in the background, and
a fetch failure leaves the workspace usable. A branch started from the cached
base fast-forwards once, but only while it still points at its first commit,
its tracked files are clean, and no agent, terminal, file edit, Git mutation or
setup has started. Existing branches and branches started at `baseCommit`
never move automatically.

Hello publishes `running` before the worker prepares its checkout. If that
preparation fails, the worker posts an empty `checkout-failed` report over its
authenticated HTTPS transport. The control plane atomically checks the current
worker token, boot ID, membership and running state, then records `failed` with
`cloud_source_checkout_failed`. A lost report response can be retried without
changing the original failure; a newer boot, wake, stop or revocation fences
the old report. Clone failures before hello use the same terminal reason instead
of retrying into a boot timeout. Neither path deletes files or checkpoints, and
the desktop displays checkout guidance through its existing failure surface.
Older workers retain their existing hello behavior; newer workers tolerate an
older control plane returning 404 for the report. Deploy the API and matching
SHA-pinned worker together to get the full failure handling.

Creation pins the active Cloud Computer build. Its inline setup command, at
most 8,000 characters, requires `workspace-setup-v1` on both HTTPS and WebSocket
configuration carriers. An admin may instead select a **Workspace setup script**
for each repository in Cloud Computer settings. The optional `setupScript`
path replaces only workspace execution; builders continue to validate the
inline command and log the selected path without executing the selected script.
The path is pinned in the immutable build recipe, bound to the original
repository ID. Before a VM-loss restore changes `computer_build_id`, its existing
restore journal retains the original setup build, including an absent selection.
A newer build selecting a different script for the same repository cannot
replace it. Legacy restore journals with no proven original selection refuse
a selected script. No database migration is needed.

A selected script requires exact `repository-setup-v1` acknowledgement on both
configuration carriers. An older worker is refused, never silently given an
inline fallback. The path must be relative, at most 512 characters, with no
traversal, control characters or private-state components. After checkout refresh
settles, the worker reads that path's regular Git blob from HEAD: untracked files,
symlinks, submodule entries, NUL, invalid UTF-8 and scripts over 64 KiB are refused.
Staged or working-tree edits do not change the admitted blob. Frozen bytes run
through an inherited private descriptor, so scripts should resolve resources from
the checkout working directory rather than `BASH_SOURCE`.

When checkout creates a new workspace branch, setup runs in the
background with `bash -lc` as `user`, in the checkout, with the same child
environment and GitHub broker as terminals. It does not delay `ENGINE_READY`.
While the branch can still fast-forward, setup waits for the background fetch.
After a checkpoint restore, setup runs once even though the branch exists.
Admission and status are saved before execution under
`/home/user/.local/share/zeros/cloud-worker/workspace-setup/<workspace-id>.json`.
The sibling `.log` keeps bounded output privately on the VM (at most 256 KiB).
The worker does not dump the script body, but Bash diagnostics may quote tracked
script text. Selected application values are scrubbed before persistence,
including when they appear in diagnostic fragments. The status records only the
selected path and commit/blob IDs.
Refresh, wake and restart never rerun an admitted script. A failed script
or refused selection leaves the workspace available without inline fallback.
The one-hour deadline and Stop cancel setup; completion retires its native
process group. Worker cancellation is synchronous before configuration
drains, and is checked again after source/admission awaits immediately before
spawn. Stop joins setup before its acknowledgement. A restored disk admits setup
once again because checkpoints exclude its admission state and dependencies.

Boat deletes a stopped VM's disk after 14 days, so every stop also saves a
checkpoint in our own object storage. It is kept until the workspace is
deleted. After the worker acknowledges Stop, the control plane runs one
command on the VM, bounded to 540 seconds. The command stops the worker
service, collects the checkpoint, encrypts it and uploads it through a
presigned URL that expires in 15 minutes. Boat stops the VM only after that.

A stop that finds the workspace exactly as the last checkpoint holds it keeps
that checkpoint instead of uploading an identical one. The command compares a
fingerprint of what it would save: the manifest, with the index and worktree
trees in place of their commits, and digests of the ignored files,
attachments and session files by name, kind, permission bits, link target
and content. Times and owners never count, because the worker rewrites
unchanged files on every boot. The fingerprint also covers the capture
itself, so a release that changes what is saved starts a new comparison. A
checkpoint is reused only when everything it left out is still reachable from
the current base branch, only by the object it was recorded for, and only
after the control plane confirms that object's stored size. A part that
cannot be read disables reuse; it is never skipped. Each stop's `checkpoint`
timing record says whether it saved a new checkpoint or kept the last one.

A checkpoint holds:

- the workspace repository's Git state: branches with their local commits,
  tags and what only they reach, stashes, upstream settings with their
  remotes' effective URLs and push URLs (after `insteadOf` rewriting, without
  credentials) and fetch settings, the index, and every tracked or untracked
  file that is not ignored;
- ignored files of up to 1 MiB outside ignored directories, such as
  `.env.local`, 32 MiB in total;
- completed composer attachments up to 500 MB each in the current
  `.context/attachments/<id>/<file>` layout and the legacy `local/shared`
  layouts under `.context` or `.context-graph`, even when those directories
  are ignored;
- the worker's state directory and the agents' session files (`.claude/projects`,
  `.codex/sessions`, `.cursor/chats` and `.cursor/projects`).

It never holds credential files, the worker token, setup status, incomplete
attachment uploads, or other ignored
directories such as dependencies and build outputs. Those come back from the
workspace's setup script and credential delivery. Git objects that the
base branch already has stay out, so a checkpoint normally holds only the
user's own work. Edits to files marked assume-unchanged or skip-worktree are
kept and come back as ordinary unstaged changes, without the marks. Not kept:
the commits and changes inside a submodule's or another nested repository's own
`.git` (the Cloud Computer does not initialize submodules), and sparse-checkout
settings. A restored workspace has a full checkout, even if the replacement
checkout was sparse, and every saved file comes back. Restore does not remove
untracked files in the replacement checkout.
Ignored attachments use a separate archive, avoiding large Git objects and
duplicate copies of files already captured by Git. Capture visits only the
registered layout's fixed depth, skips symlinks and rejects oversized files
instead of reporting a successful checkpoint without them. Restore validates
regular-file entries and refuses symlink parents in the replacement checkout.
Attachments share the existing combined 4 GiB checkpoint limit; exceeding it
records the existing checkpoint failure rather than silently omitting files.
An in-progress merge, rebase or cherry-pick comes back as its files, with
conflicts as unstaged changes, not as the operation itself. The capture and
restore technique follows Conductor's checkpointer (a scratch index, private
refs and `read-tree`), extended to carry objects to a different VM. Unlike
Conductor, which restores in place, a restore never runs `git clean` on the new
checkout. A checkpoint never holds the old checkout's own Git directory or the
links inside it that its `.git` file goes through. Before changing anything, a
restore refuses a checkout that keeps its Git directory inside itself under any
name but `.git`, or reaches it through anything inside itself. Cloud Computer
checkouts never do either.

The object is `cloud-v2/checkpoints/<workspace>/<checkpoint>.zck` in the
runtime bucket. It is AES-256-GCM in authenticated 1 MiB chunks, so tampering,
truncation and appended data all fail. Each checkpoint has its own random
data key, sealed in the database with the credential keyring and bound to the
workspace and object. The VM returns only one result line with the size and
SHA-256, never file names or contents. The control plane confirms the stored
size before it records the checkpoint, and only then removes the one it
replaced, never anything newer. Each entry into `stopping` has its own
generation: only that stop records its checkpoint, stops the VM, fails or
completes, and drops the worker's credentials only as it completes, so a late
step from an earlier stop can never replace a newer checkpoint, fail a newer
stop or revoke a worker that a newer wake started.
Before issuing an upload URL, the stop records until when that upload could
still land; it does so only while it still owns the VM, so none starts once
deletion has begun. The record is removed when the upload is known to be over.
A failed transfer, a timeout or a lost reply keeps it, and deletion waits for
the latest remaining one, then prunes again.
A failed or oversized checkpoint (over 4 GiB) never blocks the stop: the
previous checkpoint stays, and the workspace records `checkpoint_error`.

With `CLOUD_V2_CHECKPOINT_RETRY_ENABLED`, a stopped workspace whose latest
stop has no checkpoint is retried on a fork of its stopped VM. The VM itself
is never woken, and its creator can open it meanwhile. The first retry starts
10 minutes after the stop; later ones back off to once a day, and none starts
12 days after the stop, two days before Boat deletes the disk. Each lifecycle
process runs one retry at a time, only with a slot to spare. Boat's stop
returns while the VM is still `archiving`, for about ten seconds, and refuses
to fork it (`409 fork_failed`) until it is `archived`, so a retry checks first.
Boat names every fork "<source name> fork", whatever name is requested; the
retry asks for and records exactly that name. A retry records its fork before
requesting it and deletes it when the attempt ends; the next retry, deletion
and the Dev drain remove a fork whose reply was lost, by replaying its request
within Boat's key lifetime and by that name afterwards. A
retry's writes are fenced to the stop it retries, so a newer stop, a restore
or deletion refuses them. An oversized checkpoint or a VM Boat no longer has
ends the retries at once. When they end without a checkpoint, the control
plane logs `[cloud-v2] checkpoint retries exhausted (<code>)` with the
shortened workspace ID; the workspace keeps its previous checkpoint, if any,
for a later restore. Enable it only after forking a stopped VM is qualified
on the deployment's Boat account.

A wake whose VM Boat deleted restores the last checkpoint:

1. Pin the organization's active Cloud Computer and record the restore, with its
   own attempt ID and the exact replacement request, before anything is created.
2. Create the replacement VM under that attempt's key and its own name. A lost
   reply replays the same request and finds the same VM, even after a runtime
   release or once the pinned build is retiring. After Boat's 24-hour key
   lifetime the VM is found by its name instead, never created twice. A late
   reply for an earlier attempt cannot take a later attempt's place, and a
   later restore uses a new attempt.
3. Install the runtime and hydrate the selected repository after rechecking
   the creator's source access.
4. Download the checkpoint, verify its digest and apply it, before the worker
   starts.
5. Deliver the route and a fresh worker credential as usual.

The restore first clones the authorized repository with a scoped token, then
fetches additional base objects if the checkpoint needs them. The worker runs
setup once more because the clean replacement VM has no project dependencies.
A stop or deletion during a restore still finds the replacement. A replacement
that has not received the checkpoint is never checkpointed itself, so it cannot
replace the real one. A restore that still fails after its retries, or runs past its 25-minute
deadline, leaves the workspace `failed` with a `checkpoint_*` code. The
checkpoint stays, and Start tries the restore again; a damaged checkpoint
(`checkpoint_corrupt`) cannot be restored. A workspace with a checkpoint whose
VM Boat lost is never `sandbox_missing`: a stop finishes, and the next wake
restores. The worker's boot deadline starts again once the checkpoint is applied. Without a checkpoint, a lost VM remains `failed/sandbox_missing`. Delete removes every checkpoint object of the
workspace before workspace, account or organization erasure can finish.

Create and wake emit value-free `[cloud-v2] timing` records for allocation or
resume, runtime installation (including whether it changed), protected route,
token delivery, first hello, worker checkout/session/services and relay readiness.
Records contain a shortened workspace ID, closed phase name and duration,
without commands, paths, URLs or credentials. Optional worker timings use a
separate HTTPS endpoint with no retries; the control plane caps reports per
boot and phase in bounded memory. Diagnostics never determine startup success.
Some phases overlap or nest. `runtime_install` includes the wait for a new VM's
first command: Boat holds that command until the VM is up, about 2 s from a
snapshot. `worker_hello` runs from the workspace row's last update, so for a
create it also covers the lifecycle steps before it.

Archive sets `archivedAt` and requests the same stop lifecycle. The UI treats
a stopped or failed workspace with that flag as archived; idle stop leaves it
unset. Start restores the workspace by clearing the flag, as does a connect
request that wakes a stopped workspace. Archive is refused during creation or
deletion.

Archiving also leaves a visible copy of the workspace's `.context` files on the
Mac, under the app channel's `archived-contexts/<repository>/<workspace>/`. A
cloud workspace is copied from this Mac's existing sync folder once its
workspace document carries `archivedAt`; sleep or a lost connection is not
archive evidence, and the passive read never wakes the VM. A Local workspace is
copied just before its worktree is removed. `.context/attachments` and every
symlink are skipped; one copy holds at most 20,000 files and 1 GiB, and the
oldest copies are pruned above 5 GiB per channel. The copy is best effort and
never a restore source: a Local restore still uses its Git snapshot, a failed
copy does not block a Local archive, and unarchiving a cloud workspace never
writes the copy back.

## Restart presentation

The desktop reads main's stored account identity through `auth_get_session_user`
before waiting for a live access token. That identity releases same-account
presentation while refresh is pending or offline; it never supplies a bearer,
staff access, settings authority or membership reconciliation. The selected
organization, workspace, chat and panels remain in place during revalidation.
Confirmed sign-out or account/backend replacement retires the old bearer and
presentation before the next account opens. Late reads and writes are fenced by
the account generation, including A → B → A.

Versioned metadata envelopes in the Chromium profile are scoped by backend URL
and account ID. The organization snapshot keeps the complete membership list,
including cloud-disabled organizations, and the selected organization (up to
1,024 memberships and 1 MiB, without inline logos). The catalog keeps up to 512
documents and 2 MiB and reconstructs repository/workspace rows; cloud chat
metadata keeps up to 512 chats and 1 MiB. Both bounds prioritize the selected
destination. Invalid or oversized envelopes are ignored; an oversized replacement
write removes the older envelope so it cannot resurrect removed rows. Quota failures
are best-effort, and the unwired `cloud-chats:v1` cache is discarded rather than
promoted across accounts. Sign-out and account/backend replacement purge these
snapshots; confirmed workspace deletion removes its durable metadata and scoped
navigation. Local Personal and organization-local data retain their own storage.

Switching organizations also restores that organization's last known workspace
and chat atomically. Its bounded device map keeps Local destinations separately
from account/backend-fenced cloud entries; unreadable or unknown targets fall
back to Dashboard. Cached catalog presentation is sufficient to restore, and
switching never creates a VM wake intent. Deletion, confirmed membership loss
and account retirement prune the corresponding memories.

The organization switcher restores its cached rows without publishing a fake
`/v1/me` response or running ownership repair. Refresh-on-open keeps those rows
and the active check; long lists scroll within the shared menu. A global cloud
catalog read waits for authoritative membership and reads every eligible
organization. Membership arrival triggers validation immediately. The current
per-organization endpoint caps lists at 200 rows without a continuation cursor:
such a result is incomplete and may update known rows, but cannot prove an
omitted workspace was deleted. Only complete observations or exact deletion
evidence prune missing destinations. Restoring metadata never wakes a VM.

Cloud transcripts have a separate, disposable presentation cache in
`zeros:cloud-transcripts:v1` IndexedDB. Keys contain the backend/account owner,
a durable retirement lifetime, and the exact organization/workspace/native-chat
scoped ID. The shared implementation gives cloud an additive 8 windows / about
8 MiB in memory and 48 windows / 20 MiB on disk. Local keeps its original
16 windows / 16 MiB memory and 96 windows / 40 MiB disk budgets; the combined
budgets are 24 windows / 24 MiB memory and 144 windows / 60 MiB disk. Sizes use
Local's original character accounting, including serialized character length
for the disk index's `bytes` field. Each cloud disk window keeps up to 200 rows
and 768 KiB in those units, preserving its leading prompt and checking the final
encoded length. LRU eviction bounds both cloud tiers; cloud pending captures
share its memory budget. Local retains its lazy index load, lenient decoder,
record format and pending writes through memory eviction/release. Writes coalesce
after settlement or view eviction, never per streamed chunk. Malformed or
oversized cloud records are misses; unavailable disk and quota failures leave
the authoritative history untouched.

Stored identity starts the boot transcript read before token or VM waits.
Memory hits paint in the first visible frame and disk hits paint upon arrival,
as provisional `transcriptPresentation`. Cached rows authorize no send,
queue-drain, edit, retry, fork or completion; the composer stays editable. The
private prompt retry journal is unchanged and unconfirmed prompts are excluded
from the transcript cache. Revalidation reads the existing history window and
merges by stable message ID: unchanged rows retain references, edits replace
rows, and complete windows remove missing rows, including a confirmed empty
window. Partial windows retain the known prefix. Router-owned worker/mirror
provenance prevents a lagging mirror from replacing a known worker tail; it must
include that tail ID with matching content or newer native update stamps on
changed overlapping rows. Without a revision cursor, mirror-only tail deletion
cannot prove catch-up, so the worker presentation remains provisional until a
qualifying read. No cache read wakes a VM or activates a hidden view.
Shortened worker rows retain a bounded signature of their original content for
this comparison; a matching displayed prefix alone never proves catch-up. The
existing cloud `turnOpening` field supplies long turns' opening prompts, including
when revalidation edits only that prompt.

Sign-out and account/backend replacement rotate the durable lifetime before
purging the cloud namespace, even if IndexedDB deletion fails. Generation
fences discard pending reads/index loads and old writes; serialized mutations
order purge after already-started writes and before the next lifetime's writes.
Confirmed workspace/chat deletion prunes exact entries without crossing owners.
An empty cold/loading session cannot erase a confirmed cached window. Local
Personal and organization-local history retain their device-owned authority and
startup behavior.

A transactional change feed remains a follow-up: catalog/history writes and
deletion tombstones would advance a sequence in the same database transaction,
with scoped cursors and a bounded snapshot fallback after cursor expiry. This
change introduces no sync endpoint or worker protocol; revalidation uses the
existing catalog and history window/older-page reads.

## Durable prompt delivery

Workspaces advertising `capabilities.promptOutbox: 1` accept sends over
authenticated HTTPS independently of the streaming bridge. The desktop first
commits the message ID, selected agent/model/effort and attachment bytes to a
private retry journal, keyed by backend, account, organization, workspace and
native chat ID. It paints the user bubble immediately. A running VM shows an
ordinary bubble even while another turn runs; a queue card is reserved for a
VM that is creating, setting up, waking or otherwise unavailable.

`POST /v1/cloud-v2/workspaces/:id/prompts` returns a receipt only after the
database commits. It performs no VM or provider I/O. The same
`(workspace, userMessageId)` and payload return the original receipt; a changed
payload returns 409. A committed send owns one explicit wake when needed.
Status reads and retries of that receipt do not create another wake. A lost
HTTP response is repaired using the original ID and bytes. Before a CP receipt
exists, the app says the message is saved on this device; its private journal
resumes delivery after app restart. If private storage cannot commit, the draft
stays in the composer. The old in-memory FIFO transfers in order and removes
each entry only after that private commit.

The worker pulls through `/v2/cloud/worker/prompts/*`. A hint over an existing
hybrid connection shortens the wait. With `worker-push-v1`, the control plane
offers prompt push while its shared LISTEN subscription is healthy. After an
initial drain, an empty inbox waits locally for a hint; the minute safety pulse
repairs a missed hint without leasing an empty batch. A LISTEN gap or loss of
the last negotiated relay resumes the 25-second HTTPS long poll immediately;
reconnection drains once before waiting again. Payloads, inbox ACKs, dispatch
and Stop receipts always use the same durable HTTPS routes.

The relay is retained for attached apps, so a worker with no attached app still
uses HTTPS prompt polling and activity until the ordinary 15-minute idle stop.
Older workers or control planes also keep that fallback. Polling holds no
database connection, reports no activity and never keeps an idle VM warm.
Nothing polls or dials a stopped VM. Pending explicit
work prevents idle stop and resumes delivery when the VM is ready.

Delivery has separate durable boundaries:

| Receipt state | Meaning |
| --- | --- |
| `queued` | The control plane saved the message. |
| `inboxed` | The VM fsynced its inbox before acknowledging delivery. |
| `dispatching` | The VM saved its dispatch intent and the CP rechecked the chat epoch, boot and access before provider handoff. |
| `accepted` | The provider accepted the turn. This is separate from inbox delivery. |
| `completed`, `failed`, `cancelled`, `interrupted` | Terminal outcome; no automatic provider replay. |

Prompts drain in chat order; explicit steering retains its existing meaning.
Delivery re-adopts the saved execution and native conversation after a wake.
A restart during an uncertain provider handoff or an unfinished turn records
`interrupted`, shown as “The worker restarted before this turn finished”. Retry
is an explicit new send with a new ID. The system never treats missing provider
acceptance as proof that it is safe to run the old turn again. Legacy bridge
requests actually sent to a lost worker also settle; frames queued for its
replacement are left intact.

`POST .../prompts/stop` advances the chat's delivery epoch and atomically cancels
undelivered rows. Claims recheck that epoch; already dispatched work receives an
interrupt and settles through its own receipt. Retried Stop uses the original
epoch and cannot cancel a later send. Account, organization or workspace access
loss fences delivery. Signing out one device does not discard work authorized
and saved earlier. Idle Stop adds no access revocation before history flush.

Saved future bubbles are a presentation projection, separate from native
transcript rows. Their IDs reconcile with worker history; an earlier turn's
output cannot attach to a later queued bubble. On a running VM, the head
prompt's bubble and pending-turn working indicator publish together after the
private journal commits, with elapsed time anchored at renderer Send. That
commit also clears the submitted composer and saved draft before HTTPS replies,
only if the editor still contains the submitted document. Failed private writes
and newer edits retain their draft. Follow-ups start their own clock only when
they become the head or are dispatched; an
unavailable VM keeps the queue and Starting workspace presentation. These
client clocks survive reload and never grant delivery or execution authority.
Receipts settle interrupted or refused sends visibly, preserve Retry and release
later messages. An uncertain send retains its original repairable attempt.

An exact native terminal fact mounts the footer immediately, even while its
receipt remains accepted. Stop also ends presentation synchronously: Send
returns, the stopped pill and footer appear, and duration freezes at the click.
Cancellation operations, delivery epochs and queue fences remain in force until
confirmed independently. Native completion or failure can correct an optimistic
Stop without extending its clock; final text, foreign-turn events and later
metadata cannot. A definitive Stop refusal restores only its exact turn;
timeout or disconnection keeps the stopped presentation with the unconfirmed
notice and Retry Stop. Optional journal presentation metadata never changes the
immutable retry payload; malformed metadata is discarded without losing it.
The resident clock/ending map retains at most 256 turns per chat.

Hidden chat views own no polling; one application coordinator resumes pending
deliveries, with at most 64 active conversations and four concurrent requests.
Idle conversations have no timer.

The CP accepts at most 8 MiB per prompt, 128 pending messages and 32 MiB of
pending bodies per workspace, with 10,000 retained receipts. Terminal bodies
compact after seven days or under the 64 MiB retained-body budget; original
hashes and receipts survive compaction for idempotency. Private retry storage is
bounded to 64 MiB and 2,048 entries, with seven-day terminal/refused retention.
Recovery reads completed history from native pages instead of importing its
payloads into the private retry quota ahead of pending messages.
Chat/workspace erasure removes the corresponding outbox and private journal
records. Account and owner changes fence stale replies and never expose or
erase another owner's saved work. Local Personal and organization-local keep
their existing send paths.

## Configuration

The control plane reads these names in
[`src/config.ts`](../apps/control-plane/src/config.ts):

| Environment variable | Purpose |
| --- | --- |
| `CLOUD_V2_ENABLED` | Enables the v2 routes, the app bridge relay and lifecycle roles. |
| `CLOUD_V2_PROMPT_OUTBOX_ENABLED` | Enables durable HTTPS sends and advertises `promptOutbox: 1`. Defaults to `false`; enable only with a compatible worker runtime. `electron:cloud` defaults it to `true`. |
| `CLOUD_V2_ASYNC_CREATE_ENABLED` | Lets a create return before its GitHub checks, which the lifecycle then runs before any VM exists. Defaults to `true`; `false` keeps every create synchronous. Pending rows created earlier still resolve. |
| `CLOUD_V2_CHECKPOINT_RETRY_ENABLED` | Retries a stop's failed checkpoint on a fork of the stopped VM. Defaults to `false`; enable only after qualifying forks of stopped VMs on the deployment's Boat account. `electron:cloud` passes it through when set. |
| `BOAT_API_KEY`, optional `BOAT_BILLING_ORG` | Boat provisioning and billing. |
| `CLOUD_V2_API_URL`, `CLOUD_V2_REALTIME_URL` | Public HTTPS API (also the worker's outbound origin) and the app's WSS bridge origin. |
| `CLOUD_V2_WORKER_SIGNING_KEY`, optional `CLOUD_V2_WORKER_SIGNING_KEY_PREVIOUS` | Ed25519 PKCS#8 private key (base64 DER) that signs worker grants. VMs trust both public keys after their next create or wake, so a rotation keeps the previous key until every running VM has woken with the new trust file. |
| `CLOUD_V2_RUNTIME_SHA256` | Published runtime archive digest. |
| `CLOUD_V2_RUNTIME_RELEASE_METADATA` | Optional version-1 release provenance for the exact pin, including the Alpha qualification receipt hash and confirmed deletion. Missing or mismatched provenance stays unqualified. |
| `CLOUD_V2_RUNTIME_CANARY_CONFIG` | Alpha-only public Ed25519 verification keys and the dedicated fixture user, organization and immutable repository ID. Never contains the release signing private key. |
| `CLOUD_V2_RUNTIME_STORE_ENDPOINT`, `CLOUD_V2_RUNTIME_STORE_BUCKET` | Runtime and checkpoint object storage. |
| `CLOUD_V2_RUNTIME_STORE_ACCESS_KEY_ID`, `CLOUD_V2_RUNTIME_STORE_SECRET_ACCESS_KEY` | Server-side storage credentials. They read runtimes, and read, write, list and delete under `cloud-v2/checkpoints/`. |

The existing database, authentication and GitHub App configuration is also
required. Agent vault keys retain their persisted deployment names:
`CLOUD_WORKSPACE_SECRET_KEY_V1`, or `CLOUD_WORKSPACE_SECRET_KEYS_JSON` with
`CLOUD_WORKSPACE_SECRET_CURRENT_KEY_VERSION`. Codex renewal retains
`CLOUD_CODEX_REFRESH_FINGERPRINT_KEYS_JSON` and
`CLOUD_CODEX_REFRESH_FINGERPRINT_CURRENT_KEY_VERSION`. Keep old key versions
available to decrypt existing records.

The worker receives only the non-secret boot settings `CLOUD_V2_API_URL`,
`CLOUD_V2_RUNTIME_SHA256` and `ZEROS_WORKSPACE_ID` in its `worker.env`; its
credential comes from the token file.

A create's VM restores its disk lazily from the Cloud Computer snapshot,
and the restore gives every file a new inode and ctime. When the image holds
the workspace's checkout, the lifecycle therefore starts a detached,
read-only warm-up as the VM user as soon as the VM accepts commands: `git
ls-tree -r HEAD` reads the pack, and `git diff-files --quiet
--ignore-submodules` with `core.checkStat=minimal` stats every file. It runs
with `GIT_OPTIONAL_LOCKS=0`, fsmonitor and hooks disabled and a 60 s
timeout. A racily clean file can still get a content comparison, which for
LFS files starts git-lfs's clean filter. The warm-up still writes nothing
and downloads nothing, so it may overlap the worker's own checkout. Its failure never fails the create, and wakes skip
it. The Dev hosted-profile launcher takes
`ZEROS_CLOUD_V2_RUNTIME_SHA256` and maps it to the control-plane runtime pin,
and derives each Dev generation's worker signing key.

`pnpm --filter @zeros/cloud-worker build` produces a self-contained `dist/`.
`pnpm --dir apps/control-plane cloud-v2:publish-runtime` builds, packages and
uploads it from a clean Linux x64 checkout. Set the returned archive digest
in the target deployment. Publishing an archive alone does not change running
workspaces; create and wake apply the
configured pin. Each publish then removes that store's older runtimes and
their source indices, indices first. It keeps the live pin
(`CLOUD_V2_RUNTIME_SHA256`, which `railway run` provides, or `--keep <sha256>`),
the two newest and anything from the last day. A deployment store is pruned
only when its live pin is known, and `--no-prune` skips this. A removed runtime
can be published again from the commit its index records. Tests use fake worker connections and native provider streams;
live verification must also cover the private route, stop, offline history, wake
and deletion.

### Runtime release canaries

Runtime release support lets an Alpha release qualify a candidate without
changing the ordinary channel pin. The existing create endpoint accepts
`x-zeros-runtime-canary` only when Alpha has the public canary policy. The
single-use grant expires within 15 minutes and binds its run/attempt, candidate
digest, source commit, fixture creator, dedicated fixture organization,
immutable repository ID and create idempotency key. The normal membership,
source authorization and environment pinning checks still apply. The grant
and workspace commit in one transaction; an exact create retry returns the
same receipt, even after the admission grant expires.

Only that admitted workspace resolves to the candidate on create and wake.
An ungranted workspace, including one owned by the fixture user, uses the
ordinary channel pin. A candidate's recorded source and fixture policy must
remain verifiable; an unknown lookup refuses boot instead of falling back to
the channel pin. HTTP hello resolves the authenticated workspace's pin before
it changes the boot identity. The grant audit survives physical workspace
deletion, so its nonce cannot allocate a second workspace.

The fixture can read its exact grant at
`GET /v1/cloud-v2/runtime-canaries/:grantId`. This returns only bounded
identity, digest, run and lifecycle-state fields. It retains current creator
membership checks and reports deletion only from a retained workspace row in
the `deleted` state. An absent row or lost access is not cleanup proof.
The Alpha probe requires this proof after all three providers, files, Git,
terminal, Stop, offline history and wake succeed; it verifies the installed
candidate digest both before and after wake. It rejects `--keep` and partial
provider coverage. The existing Dev and Local gate0 target guards are unchanged.

`/v1/release-identity` reports the control plane's current `worker.sha256`.
Matching `CLOUD_V2_RUNTIME_RELEASE_METADATA` also supplies `sourceSha`,
`sourceSha256` and the Alpha qualification reference, with
`workerQualified: true`. Legacy pins remain visible with null provenance and
`workerQualified: false`. This describes the live control-plane pin, not
whether every running VM has adopted it. Runtime publication does not stop
user workspaces or change their visible state. Local Personal and
organization-local workspaces do not use this authority.

The **Cloud runtime release** runner builds from exact main source, records a
successful Alpha publication, drains admitted Computer builds and runtime
handoffs, and changes the channel pin through one redeploy of the unchanged
control-plane commit. Alpha releases publish when runtime inputs or qualifying
control-plane/protocol code change. Beta and Production releases promote the
compatible qualified Alpha pin after hosted promotion and before feed
publication. Invalid or unavailable qualification fails the release; a matching
qualified pin can skip. The dispatch wrapper remains available for manual
publication, promotion and rollback. Production retains the existing
`production-approval` gate for the runtime transaction.
Promotions copy the same retained archive; rollback selects the channel's
recorded previous digest. Neither path changes a recipe, stops a user workspace
or affects Local Personal or organization-local workspaces. Silent adoption
uses the existing quiet-workspace rules; a busy workspace waits for a safe
opportunity or its next natural wake.

The controller requires the live `runtimeBuildDrainVersion: 1` capability and
an active lease with zero live builds, unresolved provider effects and committed
adoptions. Missing or unknown support refuses pinning. Immutable release
archives and receipts survive the ordinary publisher's pruning. See
[Runtime release qualification](deployment-environments.md#runtime-release-qualification)
for provisioning, exact dispatch inputs, previous-pin verification and recovery
from an unconfirmed mutation.

### Source-authority rollout

Apply migrations `0206_github_authorization_generations.sql` and
`0207_cloud_source_boundaries.sql` before enabling the new control-plane
runtime, together with `0212_cloud_computer_source_provenance.sql`,
`0214_cloud_github_source_verifications.sql` and the
selected-credential/workspace source-ledger integration. Existing signed
GitHub bindings do not have a grant generation:
members reconnect GitHub through the existing flow. Empty repository scopes,
stale generations and new permissions unavailable from GitHub fail closed.
Existing verified running workspaces use the bounded continuation policy above.

Quiesce cloud admission and drain old builders, API and relay instances during
the cutover; an old binary does not enforce the new source policy. Use the new
builder to rebuild each active Cloud Computer, and verify
`state = 'succeeded'`, `source_policy_version = 2` and complete `source_targets`
before reopening creation and checkpoint restore. New admitted builds record
version 2 and their IDs before execution; only successful clean capture and
source/setup validation allow activation. Migration alone does not certify an
image, and an older builder still writes version 1 with unknown identities.

Migration 0212 leaves all existing build and configured-recipe identities NULL;
it does not infer them from today's repository names. The source binding and
source-bearing build recipe are immutable; completion can record commits and
branch observations. For an unverified configured recipe, an admin can remove
its entries and save, then explicitly select and save the current repositories
and build a new clean image. This establishes new provenance only: old logs
stay inaccessible and old workspace source IDs are never rewritten. Use
verified recovery evidence for old data, not a current-name lookup. A workspace
restore can change its current Computer pin, so its original source IDs must
remain in the independent workspace ledger. The current build is not evidence
of an older disk's identity.

Migration conservatively records every historical repository in an
organization on its existing pinned workspaces, including removed recipe
entries that earlier snapshots could have retained. The scope is immutable
across wake and restore. New workspaces record only their selected repository.
Existing workspaces without reliable provenance remain blocked for source
review, with their files and checkpoints retained. An admin removing a recipe
entry, switching the active image or restoring a checkpoint never narrows the
recorded scope. Recover access by restoring the creator's repository authority
or using an explicitly reviewed recovery process; do not clear the source
scope to make admission succeed.

Fresh admission has a maximum 30-second observation lifetime, measured from
before remote verification starts. For a workspace with multiple source
repositories, every observation must remain within its applicable admission
or continuation window through the complete check and final identity reads.
A slow check or a connection changed midway fails admission; retry can refresh
expired observations without narrowing the recorded source scope.

Migration 0214 starts with no permission evidence. It contains no credentials
and grants access only to the system database role. Its keys include the
organization, creator and immutable repository ID; observations also require
the exact selected-connection fingerprint. Removing organization membership
deletes its observations. Database-clock ages and claim generations keep slow
responses, clock skew and superseded refreshes from extending grace. No timer
scans this table. A replica restart can read existing evidence but cannot invent
a new grant. The migration also records canonical-name observation timestamps,
retaining existing bindings and aliases without creating permission evidence.
Keep this additive migration on rollback.

GitHub secondary limits can be HTTP 403 with a retry header or the documented
rate-limit message. These are temporary; ordinary 403/404, explicit credential
refusal and SSO requirements are denials. A failed rotating-token refresh may
have consumed the old refresh token: an uncertain result is unavailable, never
replayed or reported as confirmed revocation. Existing source grace remains
bounded; reconnect the GitHub connection to restore new access if that rotation
cannot be recovered.

Before release, qualify the actual Boat file-upload permissions, snapshot
readiness, clean disk contents, creation, stop/wake and lost-VM checkpoint
restore. Exercise a member lacking one recipe repository and access loss while
a workspace is connected. Confirm that setup depending on other repositories
has separate authorization and runs successfully in a fresh individual VM.
Mock provider tests do not establish these live properties.

Rollback keeps the additive migrations and existing checkpoints. If the new
runtime must be withdrawn, keep cloud admission closed until a compatible
fix is deployed. Reverting to a binary that ignores source scope or reusing a
legacy source-bearing shared image is not a safe rollback.

### GitHub connection and PR rollout

This extension depends on the source-authority foundation above and its
authentication cutover. Apply the additive migrations in order:

1. `0209_cloud_v2_github_metadata.sql` records checkout/PR metadata and operation
   leases.
2. `0210_cloud_github_credentials.sql` records encrypted per-person App/PAT
   credentials, selection generations, refresh leases and OAuth state.
3. `0211_cloud_github_source_identities.sql` pins each workspace's original
   source names to immutable repository IDs.
4. `0212_cloud_computer_source_provenance.sql` records Computer build, recipe
   and log provenance. The selected cloud connection resolves these IDs for
   build admission, credentials, repository listing, creation and log reads.
5. `0213_mcp_repository_identities.sql` records verified repository IDs for MCP
   definitions and native admission, and refreshes workers by their original ID.
6. `0214_cloud_github_source_verifications.sql` shares exact-generation permission
   observations, canonical names, refresh claims and retry delays across
   control-plane replicas, and orders verified canonical-binding updates.

The new cloud connection is independent of the earlier installation record and
the Local GitHub login. Members must explicitly connect and select a cloud
method, including build creators whose connection is used to validate recipes.
Keep every encryption key version needed to open existing rows.

Migration 0211 deliberately does not look up historical IDs using current
names. A transferred name can be reused, and current access does not prove
what source a legacy disk, checkpoint or build contained. For each legacy
workspace, an operator must establish the original ID of **every** entry in
its immutable source ledger from trusted admission records or equivalent
reviewed provenance. In a scoped system transaction, lock the workspace,
verify that original ledger and record only those proven mappings. Preserve
all prior entries and refuse conflicting mappings. Recheck the creator's
current access to every pinned ID before enabling reads, credentials or wake.
There is no end-user or automatic name-based backfill endpoint. Without this
evidence, keep `cloud_source_review_required`, the disk and the checkpoint;
do not clear source scope, change the ID to a new name's occupant, or delete
user work to make admission pass.

A legacy organization's **Cloud Computer** can be recovered without that
historical backfill: an admin reviews its current repositories in Settings →
Cloud Computer and saves or starts a fresh build. Manual admission resolves
current access and records new IDs, while the builder captures a clean stock
snapshot before any source or credential reaches it. Keep the old build rows
and logs unverified; automatic refresh and reactivation cannot perform this
admission. Existing legacy workspaces still require the operator evidence
above and remain under `cloud_source_review_required` after the new Computer
becomes active. No database migration is needed for this manual rebuild path.

Roll out the compatible database and API/relay/lifecycle code together with
the security cutover. Publish a matching SHA-pinned worker, verify new creation
and wake with its canonical binding and checkout report, then enable the
desktop controls through the advertised capability. An older worker without
checkout reports does not gain PR creation by pretending that its saved
branch metadata is current. Existing snapshots must satisfy the clean-image
policy before new admission or replacement restore.

Before release, qualify App and PAT with allowed, denied and read-only
repositories, SSO/installation restrictions, rotation/revocation, transfer and
old-name reuse; exercise PR creation/discovery/checks/review and a normal
stop/wake and lost-VM restore. Include the Computer build/log boundary in live
qualification: verify that historical logs and recipe admission cannot
authorize the new occupant of a reused name, and that a transfer during token
issuance or clone prevents setup and activation. Workspaces' pinned IDs do not
retroactively establish build provenance. Review and rebuild an unverified
name-only recipe against the intended canonical repository before new
admission. Offline regressions cover these checks; they do not establish the
deployed GitHub/Boat behavior.

Keep migrations and retained user data on rollback. Withdraw the new UI
capability or close cloud admission while fixing incompatible code; never
fall back to broad installation tokens, another person's credentials or
legacy source-bearing images. A merged PR or published runtime alone is not
evidence that these deployables and recovery steps have reached users.

### Outbox rollout

Apply expand migration `0202_cloud_v2_prompt_outbox.sql`, publish the compatible
worker and select its runtime SHA before enabling the flag. The worker's hello
advertises `X-Zeros-Worker-Features: prompt-outbox-v1`; an enabled CP refuses
an incompatible hello. Refresh existing workers onto that runtime/configuration
before accepting new outbox work. A flag change alone does not update a detached
worker immediately: creation/wake installs the selected runtime and hello
receives configuration. Plan those refreshes after running turns have settled.

Older desktops continue using the bridge path; live streaming is unchanged.
For rollback, settle or explicitly cancel saved work before disabling the
outbox routes or downgrading workers. Keep the additive schema and receipt
history. Disabling the flag cannot deliver already committed rows through an
older desktop's memory queue.

Live qualification includes receipt latency, app quit and reconnect with queued
messages, stopped-VM FIFO delivery, same-ID replay, Stop racing delivery,
sign-out versus real access loss, wake into the same chat and a mid-turn worker
restart. Existing gate0 provider turns still exercise the legacy bridge path;
test the new HTTPS path separately without silently adding provider turns.
