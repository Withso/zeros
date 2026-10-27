# Cloud workspaces

Cloud v2 gives each workspace one Boat VM with a standalone
[`apps/cloud-worker`](../apps/cloud-worker/) process. The desktop shares its
chat, files, Git and terminal UI with Local. Cloud advertises Browser, Design
and simulators as unavailable. Local Personal and organization-local workspaces
keep their own engine, provider permissions and Host lifecycle.

Cloud requires a non-personal organization with `cloud_workspaces_allowed`.
Only the workspace creator can list, connect to or manage it, and they must
still belong to that organization. Organization admins manage the shared
Cloud Computer; ordinary members can read its installed repository list.

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
installation tokens. Each request carries the worker credential and the
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

A build starts from the live snapshot when there is one, otherwise from Boat's
stock image. It installs the runtime, then fetches existing checkouts and moves
them to the recipe's ref in place, keeping ignored files such as installed
dependencies. It clones added repositories, deletes removed ones and runs the
setup scripts. It records each repository's branch and commit and the runtime it
cached. A successful build becomes the active snapshot, and the temporary
builder is deleted. An inactive build's snapshot is deleted once no creating
workspace still needs it; its recipe stays in the history. Activating an older
build rebuilds it at the same commits and makes its repositories the configured
ones. If Boat no longer has the live snapshot, the build fails and the next one
starts clean.

The builder also refreshes the snapshot without being asked. A new runtime pin
refreshes the runtime only, without Git or setup, so creates and wakes stop
downloading it; failures are retried after six hours, at most three times per
pin. Once a day, an organization that used cloud workspaces in the last week is
rebuilt at its live build's refs when GitHub reports a moved branch; unbuilt
edits are left for an admin to build. An organization with no new commits is
not checked again for a day, one GitHub cannot answer for an hour, and
organizations are visited earliest-due first. An automatic refresh
is fenced to the live build it was scheduled from, so a build that became live
meanwhile is never relabelled or rolled back, and a rebuilt older build is never
refreshed this way. Scans run beside build admission, never ahead of it. Each
lifecycle process runs one build at a time: a build holds a dedicated lock
connection for its whole run.

New workspaces fork the snapshot of the build they pinned at creation. The
worker fetches origin and switches to the workspace branch, creating it from
the selected base only when absent; it never resets an existing branch.
Runtime updates never require a manual rebuild of the Cloud Computer.

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
request short-lived GitHub installation tokens through the worker's broker.
Credentials must never be written to transcripts, command arguments or logs.

Customize stores organization MCP definitions separately from provider logins.
Definitions can be organization-shared or private to one member and can target
all repositories or one admitted GitHub `owner/repo`. The control plane
encrypts variable/header/client-secret values, OAuth attempts and per-user
grants; edits use definition revisions and recheck membership, role and
repository admission. Each member authorizes their own account for a shared
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

A new workspace branch starts from the Cloud Computer checkout already on
disk, so the worker becomes ready without waiting for GitHub. At creation the
control plane records GitHub's head of the base branch. Workers advertising
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

A checkpoint holds:

- the workspace repository's Git state: branches with their local commits,
  tags and what only they reach, stashes, upstream settings with their
  remotes' effective URLs and push URLs (after `insteadOf` rewriting, without
  credentials) and fetch settings, the index, and every tracked or untracked
  file that is not ignored;
- ignored files of up to 1 MiB outside ignored directories, such as
  `.env.local`, 32 MiB in total;
- the worker's state directory and the agents' session files (`.claude/projects`,
  `.codex/sessions`, `.cursor/chats` and `.cursor/projects`).

It never holds credential files, the worker token, setup status, or ignored
directories such as dependencies and build outputs. Those come back from the
Cloud Computer, the setup script and credential delivery. Git objects that the
base branch already has stay out, so a checkpoint normally holds only the
user's own work. Edits to files marked assume-unchanged or skip-worktree are
kept and come back as ordinary unstaged changes, without the marks. Not kept:
the commits and changes inside a submodule's or another nested repository's own
`.git` (the Cloud Computer does not initialize submodules), and sparse-checkout
settings. A restored workspace has a full checkout, even if the new Cloud
Computer checkout was sparse, and every saved file comes back. Untracked files
that the new checkout itself has, from the Cloud Computer, stay, as in any new
workspace.
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

A wake whose VM Boat deleted restores the last checkpoint:

1. Pin the organization's active Cloud Computer and record the restore, with its
   own attempt ID and the exact replacement request, before anything is created.
2. Create the replacement VM under that attempt's key and its own name. A lost
   reply replays the same request and finds the same VM, even after a runtime
   release or once the pinned build is retiring. After Boat's 24-hour key
   lifetime the VM is found by its name instead, never created twice. A late
   reply for an earlier attempt cannot take a later attempt's place, and a
   later restore uses a new attempt.
3. Install the runtime.
4. Download the checkpoint, verify its digest and apply it, before the worker
   starts.
5. Deliver the route and a fresh worker credential as usual.

The restore fetches from GitHub, with a repository token, only when the
Cloud Computer lacks a base commit the checkpoint needs. If the Cloud Computer
no longer has the repository, the restore clones it. The worker then runs the
setup once more, because the replacement VM comes from a newer Cloud Computer.
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
configured pin. Tests use fake worker connections and native provider streams;
live verification must also cover the private route, stop, offline history, wake
and deletion.

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
