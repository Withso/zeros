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

App tickets and open clients retain the creator's verified WorkOS session ID.
Signing out closes only that session's clients and expires its unused tickets;
other devices, running turns and worker credentials remain live. Admission,
app requests and security notifications recheck that session in the database,
with the relay heartbeat repairing missed notifications. Account, organization
and workspace authorization loss still revoke the whole workspace room.

The worker keeps outbound HTTPS to the control plane under
`/v2/cloud/worker/*` for work that continues without an attached app: `hello`
and configuration, the history mirror, activity reports and GitHub
credentials. Each request carries the worker credential and the
worker's boot identity; history batches are sequenced per boot so a retried
batch is a no-op. A renderer `workspace.list` row from the worker uses native
paths and the workspace UUID, not the HTTP workspace document shape; the
renderer translates native checkout paths and IDs into scoped `cloud://`
identities.

On create and wake, the control plane installs its selected runtime tarball
from object storage, verifies its SHA-256 and caches it under
`/opt/zeros/runtime/<sha256>`. `/opt/zeros/worker` points to that directory.
The runtime is root-owned; `zeros-worker.service` runs `worker.mjs` as `user`.
The same step writes the control plane's public verification keys to
root-owned `/opt/zeros/worker-auth.json`. Every wake rotates the worker
credential in `/home/user/.config/zeros/worker-token` (mode `0600`) and
restarts the worker, which registers a new boot identity in `hello` before the
control plane dials it. The worker rereads the credential on every request.

Each organization has one Cloud Computer: a configured recipe and an active
named snapshot. Admins edit the recipe (repositories, branch or tag, setup
script) as an organization setting, saved at a revision so concurrent edits
from other admins or devices are refused rather than lost. Repositories stay
until an admin removes them. Settings shows the difference from the live build
as unbuilt changes, with Discard and Build computer; nothing changes for
workspaces until a build succeeds. Older apps that send the repositories with
the build still work, and their selection becomes the configured recipe.

A build always starts from Boat's stock image. It installs the pinned runtime
and waits for Boat to finish capturing a clean snapshot **before** delivering
any repository credential, cloning source or running recipe scripts. It then
validates the repositories and setup scripts on the disposable builder,
recording each branch and commit. Only a successful validation makes that
snapshot active. The shared image caches the runtime; it contains no project
checkouts, dependency trees or setup outputs. Deleting a checkout after setup
would not establish this boundary, because setup can copy source elsewhere.

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

The builder also refreshes the snapshot without being asked. A new runtime pin
queues another clean image and validates the recipe on its disposable builder,
including Git and setup. A snapshot whose build recorded no runtime is
refreshed the same way. A refresh installs the runtime it was queued for, even
when a process still on the previous pin picks it up during a deploy.
Failures are retried after six hours, at most three times per pin. Builds and
their cleanup hold their locks on a separate two-connection pool, so the
lifecycle's two database connections stay free. Once a day, an organization that used cloud workspaces in the last week is
rebuilt at its live build's refs when GitHub reports a moved branch; unbuilt
edits are left for an admin to build. An organization with no new commits is
not checked again for a day, one GitHub cannot answer for an hour, and
organizations are visited earliest-due first. An automatic refresh
is fenced to the live build it was scheduled from, so a build that became live
meanwhile is never relabelled or rolled back, and a rebuilt older build is never
refreshed this way. Scans run beside build admission, never ahead of it. Each
lifecycle process runs one build at a time: a build holds a dedicated lock
connection for its whole run.

New workspaces fork the clean snapshot of the build they pinned at creation.
After checking the creator's repository access, the control plane clones only
the selected repository into that VM. The worker switches to the workspace
branch, creating it from the selected base only when absent; it never resets
an existing branch. Setup runs inside the individual workspace. Creation and
replacement-VM restore therefore need GitHub and can take longer; ordinary
wakes preserve the existing disk and installed dependencies. Runtime updates
continue to refresh automatically. The transition from legacy source-bearing
images requires the coordinated rebuild described below.

Repository authorization uses the immutable GitHub user ID and the exact
connection generation, verifies read or write permission as needed, and
mints installation tokens for explicit repositories and permissions only.
Additional repositories need separate authorization; a shared recipe is not a
credential grant. New connections, create/wake/restore, GitHub credentials and
PR actions require source verification no older than 30 seconds, measured
before remote I/O. Running workspaces reuse exact-source permission evidence
for ten minutes, then refresh it on actual work in the background. During a
GitHub outage or rate limit, existing chat, files, terminal, history and model
proxy requests can continue for at most one hour from the original successful
verification. Failures never restart that clock. Confirmed denial, disconnected
credentials, changed connection generations and unverified source IDs cannot
use grace. Organization membership, worker boot and app session checks still
apply independently.

The relay's 30-second transport heartbeat sends only socket pings; it does not
poll GitHub, login revisions or per-workspace database authority. Security and
login notifications invalidate observations, and actual traffic repairs missed
notifications and checks session expiry. Permission refreshes share a bounded
cache and one in-flight check per actor within a replica. Durable observations,
short compare-and-set claims and actor cooldowns coalesce replicas. Transient
failures back off from one to fifteen minutes, with bounded jitter, and respect
GitHub's longer retry delay. An idle workspace does not refresh GitHub access.

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
the worker's broker. With the GitHub App selected, Git receives an installation
token narrowed to the pinned repository and the human's current read/write
permission; `gh` receives the human's App user token. With PAT selected, both
receive that PAT. Broker caching is bounded to two minutes, but does not shorten
a credential's GitHub lifetime or reduce a PAT's scopes. A user token delivered
to the VM can be used by any process there, including other agent sessions.
Control-plane clone commands receive their one-command authorization header
through a private Boat file upload, opened and unlinked before execution, then
passed on stdin. Git reads it through an environment reference. Neither the
token nor its encoded header belongs in command arguments, remote URLs,
transcripts or logs. This protects command metadata, not other processes
already running with the same VM permissions.

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

The worker folds native streams through the shared `applyUpdate` reducer and
persists chat/session state under `/home/user/.local/share/zeros/cloud-worker`.
It mirrors chat metadata, deletions and message rows to the control plane.
The app can read that history while the VM sleeps. This history mirror is
separate from repository files; there is no Mac checkout synchronization.

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
which the renderer treats as unavailable history. Reset/undo remain Local-only.

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
refresh token. Reconnect starts a new generation. Every operation checks the
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
Private workspace comments remain unavailable in cloud; a GitHub reply or
line comment is explicitly posted to the PR and never written to Local SQLite.

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

## Lifecycle

Each lifecycle replica admits up to four workspace steps concurrently and
excludes its in-flight workspaces from further claims. Creates, wakes and
deletions are claimed first. Stops can spend minutes saving a checkpoint, so
they use at most two of the slots, and a slow stop never holds up another
workspace's creation. Running VMs receive a 24-hour Boat
lease; a bounded background scan renews it after about 12 hours.

The lifecycle loop stops a running VM after ten minutes without activity
reports. Turns, workspace setup and recent terminal input/output keep reports flowing; an
untouched shell eventually becomes idle. Passive history reads do not wake
the VM, and neither do reconnects: `/connect` accepts `{ "wake": false }`, and
the single-use ticket carries that intent through bridge admission. The app
asks to wake only for an explicit open; a missing value still wakes, for older
callers. Explicit work over the bridge, or Start, wakes it and reconnects the
worker. Stop
retains the VM disk and saves a checkpoint; Delete removes the VM, its
checkpoints and its access. Account
and organization deletion also enqueue their workspaces for cleanup.

A new workspace branch starts from the authorized checkout hydrated into its
own VM before worker startup. At creation the control plane records GitHub's
head of the base branch. Workers advertising
`checkout-v2` receive it as `baseCommit` and start the branch there when the
VM has that commit; otherwise the branch starts from the cached
`origin/<baseBranch>`. The worker then fetches `origin` in the background, and
a fetch failure leaves the workspace usable. A branch started from the cached
base fast-forwards once, but only while it still points at its first commit,
its tracked files are clean, and no agent, terminal, file edit, Git mutation or
setup has started. Existing branches and branches started at `baseCommit`
never move automatically.

Creation pins the active Cloud Computer build. The worker receives that
build's repository setup script, at most 8,000 characters, only when it
advertises `workspace-setup-v1` on both HTTPS and WebSocket configuration
carriers. When checkout creates a new workspace branch, setup runs in the
background with `bash -lc` as `user`, in the checkout, with the same child
environment and GitHub broker as terminals. It does not delay `ENGINE_READY`.
While the branch can still fast-forward, setup waits for the background fetch.
After a checkpoint restore, setup runs once even though the branch exists.
Admission and status are saved before execution under
`/home/user/.local/share/zeros/cloud-worker/workspace-setup/<workspace-id>.json`;
the sibling `.log` keeps the first 256 KiB of output, privately on the VM.
Refresh, wake and restart never rerun an admitted script. A failed script
leaves the workspace available; Stop cancels and joins setup before its ack.

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

Archive sets `archivedAt` and requests the same stop lifecycle. The UI treats
a stopped or failed workspace with that flag as archived; idle stop leaves it
unset. Start restores the workspace by clearing the flag, as does a connect
request that wakes a stopped workspace. Archive is refused during creation or
deletion.

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
hybrid connection shortens the wait; a missed hint is repaired by a bounded
long poll. Polling holds no database connection, reports no activity and never
keeps an idle VM warm. Nothing polls or dials a stopped VM. Pending explicit
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
| `CLOUD_V2_CHECKPOINT_RETRY_ENABLED` | Retries a stop's failed checkpoint on a fork of the stopped VM. Defaults to `false`; enable only after qualifying forks of stopped VMs on the deployment's Boat account. `electron:cloud` passes it through when set. |
| `BOAT_API_KEY`, optional `BOAT_BILLING_ORG` | Boat provisioning and billing. |
| `CLOUD_V2_API_URL`, `CLOUD_V2_REALTIME_URL` | Public HTTPS API (also the worker's outbound origin) and the app's WSS bridge origin. |
| `CLOUD_V2_WORKER_SIGNING_KEY`, optional `CLOUD_V2_WORKER_SIGNING_KEY_PREVIOUS` | Ed25519 PKCS#8 private key (base64 DER) that signs worker grants. VMs trust both public keys after their next create or wake, so a rotation keeps the previous key until every running VM has woken with the new trust file. |
| `CLOUD_V2_RUNTIME_SHA256` | Published runtime archive digest. |
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
credential comes from the token file. The Dev hosted-profile launcher takes
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
