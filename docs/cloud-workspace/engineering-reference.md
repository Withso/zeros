# Cloud workspace engineering reference

Cloud execution is Boat-only: saved v2 Computer source, qualified v4 runtime,
actor protocol 2. [Architecture](architecture.md) owns the end-to-end boundaries;
[qualification status](qualification-status.md) owns release evidence. The
source map below describes current repository behavior, not a live deployment.

## Source map

Paths in this table are relative to the stated directory.

| Responsibility | Current source |
| --- | --- |
| Generation floor and immutable source | `apps/control-plane/src/cloud-workspaces/supported-generation.ts`, `computer-workspace-source.ts`, `generation-pins.ts` |
| Lifecycle, setup, retry deadlines and fresh readiness | Same directory: `routes.ts`, `reconciler.ts`, `setup-worker.ts`, `worker-scheduler.ts`, `setup-materials.ts`, `setup-resume.ts` |
| Computer authority, builds and cleanup-only retirement | Same directory: `computer-identity.ts`, `computer-v2.ts`, `computer-template-worker.ts`, `computer-retirement.ts`, `computer-retirement-boat.ts` |
| Runtime selection, transfer and staging | Same directory: `runtime-selection.ts`, `runtime-transition.ts`, `runtime-transfer.ts`, `runtime-staging.ts`, `runtime-resident-update.ts` |
| Durable commands, receipts, records and history | Same directory: `commands.ts`, `action-receipts.ts`, `durable-record.ts`, `history.ts` |
| Actor/device authority and native services | Same directory: `actor-sessions.ts`, `engine-client-admission.ts`, `access.ts`, `runtime-access.ts` |
| GitHub read and per-operation write authority | Same directory: `github-read-routes.ts`, `github-read-proxy.ts`, `github-write-grants.ts`, `github-native-grants.ts` |
| Funding, usage and durable storage | Same directory: `paid-authority.ts`, `compute-funding.ts`, `compute-leases.ts`, `object-store.ts`, `object-maintenance.ts` |
| Protected base and pinned runtime | `scripts/cloud-workspace-validation/runtime-base-v4/`, `runtime-bundle/`, `sandbox/setup-cloud-workspace.mjs`, `sandbox/attest-cloud-worker.mjs` |
| Live engine/transport/publication | `apps/desktop/src/engine/zeros-engine.ts`, `files/cloud-workspace-ownership.ts`, `workspace/service.ts`, `apps/desktop/src/engine/transport/cloud.ts` |
| Exact desktop routing and receipt recovery | `apps/desktop/src/renderer/platform/bridge/workspace-runtime-client.ts`, `cloud-agent-connection.ts`, `open-cloud-runtime.ts` |
| Create, catalog, wake/restart | `apps/desktop/src/renderer/state/cloud-workspace-create.ts`, `cloud-workspace-catalog.ts`, `cloud-workspace-wake.ts`, `cloud-workspace-restart.ts` |
| Native access and replica lifetime | `apps/desktop/electron/cloud-workspace-access-broker.ts`, `cloud-workspace-ssh-runtime.ts`, `cloud-workspace-port-forwarding.ts`; engine `cloud-replica-broker.ts` |
| Desktop transcript presentation cache | `apps/desktop/electron/cloud-transcript-cache-store.ts`, `ipc/commands/cloud-transcript-cache.ts`; renderer `state/cloud-transcript-cache.ts` |

Applied migrations remain forward-only compatibility contracts. Historical
schema numbers do not describe executable worker support. Do not rename a
migration or infer the current schema from the last migration named in an old
plan. The canonical ladder and alias handling in `apps/control-plane/src/migrate.ts`
remain authoritative. See [database qualification](database-qualification.md).

## Bootstrap and readiness

The fixed setup executor carries one bounded expiring envelope to the
image-owned helper; repository text never becomes a privileged command.
Claims and final publication recheck workspace, generation, allocation, lease,
setup-run and fence. Setup logs are sanitized and capped at 256 KiB; arbitrary
exception messages are not durable diagnostics. A process exit or live broker
alone cannot publish ready: exact attestation, fresh registration, protocol,
health and initial durable sync are required.

Protected deployment/launch layout is in [runtime bundles](runtime-bundles.md)
and [security](security.md). Preserve observable bootstrap names:
`ZEROS_CLOUD_PORT`, `ZEROS_CLOUD_TOKEN`, `ZEROS_ACCOUNT_JWT_*`,
`ZEROS_REQUIRE_ACCOUNT`, `ZEROS_CLOUD_OWNER_SUB` and
`ZEROS_ACCOUNT_JWT_CONTRACT=zeros-access-v1`. WorkOS launch material binds one
issuer/client ID; partial/mixed issuer contracts fail closed. These names do not
authorize historical executable profiles.

`CLOUD_WORKSPACES_ENABLED`, `CLOUD_WORKSPACE_SETUP_WORKER_ENABLED` and the desktop
build capability `ZEROS_CLOUD_WORKSPACES_ENABLED` remain independent release
gates. Credentials do not enable them. Desktop capability is baked into engine,
main and sidecar artifacts; launch-time overrides cannot enable a disabled
package. Preview suffixes and SSH host pins are separately validated public
configuration. A preview-free release keeps Local previews and independently
admitted runtime tunnels available. See
[desktop compatibility](../desktop-client-compatibility.md).

Late provider results cannot overwrite newer intent/generation state. Stop,
archive, delete and authority loss retire runtime/service grants and setup work.
A provider timeout is unknown until reconciled; acceptance/404 is not physical
storage-erasure proof. Keep exact cleanup journals until terminal evidence.

## Git and GitHub

### Accepted source and target

Creation binds repository installation/immutable ID, accepted SHA and coherent
named source/PR metadata. Default/commit sources use the Local branch allocator;
named branches retain their name. PR head/base/number/state must match the
accepted SHA. Targets are named branches, never commit IDs. A matching persisted
row wins on restart, retaining the user's target, PR linkage, index and edits.
Only old empty/SHA targets are repaired from verified named metadata, without
moving HEAD. Migration 0132 stores the immutable checkout source; old source rows
remain nullable compatibility data. See [template forks](template-forks.md).

Cloud checkout fetches full accepted-source and target history, unshallowing a
prepared clone when needed. Each attempt has a 60-second / 256 MiB object-growth
bound, sampled every 250 ms, then TERM/KILL cleanup (two-second kill grace).
Only a budget limit permits depth 128 fallback; authentication/other errors fail
immediately. Two attempts may consume twice the per-attempt bound and one sample
can overshoot it. These are object-growth guards, not exact network-byte quotas.

Changes/Review show the actual shallow flag in their one status banner.
**Fetch full history** is explicit, single-flight and actor-authorized;
`unshallow:true` is part of the grant digest. It preserves HEAD/index/edits and
uses the same 60-second/256 MiB guard with a 90-second renderer request budget.
There is no automatic retry/depth fallback for this action. Only confirmed
non-shallow status clears the notice. Hidden and Local tabs make no notice reads.

### Read and write authority

Computer bootstrap GitHub tokens are revoked and their projection removed.
Repository/PR discovery uses the backend installation read proxy with a current
read-capable actor, exact engine/source/repository and authority rechecks after
I/O and cache hits. Fixed REST/GraphQL policy rejects arbitrary queries,
contents, origins and mutations. Bounds per CP process: 8 MiB response,
64 upstream operations, 256 responses/32 MiB, 5-second fresh cache and
5-minute ETag reuse; 240 requests/workspace/minute across at most 1000 workspace
budgets. Installation tokens are memory-only (64 entries, expiry-minus-five-
minutes), repository identity checks expire after 60 seconds (256 entries).
Shutdown drains/revokes and aborts pending reads. These are process-local limits,
not fleet-wide quotas. See the `github-read-*` sources/tests.

Managed Fetch/Pull/Push and PR mutations use the exact actor's desktop courier.
Fetch/Pull redeem upload-pack-only authority; Pull composes the actor's commit
author scope, strategy and explicit autostash with the grant digest. Native Git
tries at most four distinct eligible devices of that actor after a null reply,
within one 15-second deadline. Session/connection binding, cancellation and
expiry apply throughout. No desktop means a clear authorization failure, never
another member's credentials or automatic write replay. Another actor typing
in a terminal retires its creator's Git authority; create a new terminal.

Push admits one current branch, upstream by default and explicit
`--force-with-lease`; tags/ref deletion/multiple refs are denied. Prompter/viewer
reads do not grant writes. Expiry/revocation requires explicit fresh authority.
Git/PR reads still need a running engine; stopped history endpoints cover chats,
not an invented durable offline Git API.

### Shared Git invariants

All/Uncommitted/Staged/Unstaged derive from their own comparisons. An `AD` path
contributes 0/0/1/1; Changes counts All. Target selection changes metadata only;
fetch/rebase/merge/autostash/Continue/Abort remain explicit. Conflicts pause Design
until shared source resolution. Checked publication keeps engine-authored Code
and Design writable by the contained worker without widening protected roots.

Direct and draft-direct Create PR intentionally commit the exact net pending
Code+Design before push/create. Empty/conflicted state is refused; a successful
commit survives publication failure, so a retry resumes publication. The same
explicit behavior applies to Personal Local, organization Local and cloud.

## Local and cloud regression guards

Placement, owner and selection are independent. A parsed cloud key, cloud
connection or immutable worker marker selects cloud behavior. Personal Local
and organization Local retain the sidecar, native credentials, checkout/worktree,
Git/GitHub and offline source/history. Importing shared modules does not resolve
cloud deployment authority. A present retired marker refuses cloud execution;
an absent marker is the Local path.

Paths below are relative to `apps/desktop/`; suite names are adjacent regressions,
not a claim that native macOS qualification passed.

| Shared area | Local guard and switching contract | Regression anchors |
| --- | --- | --- |
| Runtime/requests | Local CONNECTED is immediate; sent requests reject on disconnect and are not replayed. Cloud readiness/caps do not affect the sidecar. | renderer `platform/bridge/__tests__/ws-client-local-lifecycle.test.ts`, `workspace-runtime-client.test.ts`; engine `__tests__/local-workspace-dispatch.test.ts` |
| Git/GitHub/Design | No cloud grant/actor/source-generation precondition for Local reads or Undo/Redo beside an active cloud peer. Local tokens and viewer hints remain authoritative. | engine `git/__tests__/github-local-read.test.ts`, `diff.test.ts`, `fetch.test.ts`; renderer `platform/bridge/__tests__/design-bridge.test.ts`, `features/design-workspace/__tests__/design-workspace-cache.test.ts` |
| Provider/native imports and forks | Cloud CLI/lease/language/fork paths require immutable worker authority; Local imports/forks do not resolve or copy cloud credentials/history. | engine `agents/__tests__/cloud-language-local-import.test.ts`, `gateway-cloud-fork-runtime.test.ts`, `__tests__/engine-startup.test.ts` |
| Create/settings/resource/ports | Personal does not mount Computer reads; org-Local metadata does not gate its engine. Cloud pending/usage/ports caches are account/org/workspace/generation keyed; passive reads never wake. | renderer `state/__tests__/cloud-workspace-create.test.ts`; settings/create-gate and resource/ports hook suites |
| Shared conversation/status UI | Two-row header is shared; Local Open In uses its checkout and cloud Open In uses a real Local replica. One tab frame retains exact-key content and gates hidden effects/focus/polling. Cloud status/restart is in details. | renderer `shell/__tests__/conversation-header-open-in.test.ts`, workspace-header/tab-status/access-control suites |
| Durable cloud transcript cache | Local IDs bypass IPC and cloud revision filtering. Optional cache cleanup failure cannot stop Local command registration; retired cache epochs cannot revive across account switches. Cached text does not satisfy send/completion. | electron `__tests__/cloud-transcript-cache-lifecycle.test.ts`; renderer `platform/__tests__/cloud-transcript-cache-history.test.ts`, `features/agent/__tests__/cloud-transcript-cache-hydrate.test.ts` |
| Native access and release configuration | Typed cloud targets/main-owned device grants gate forwards/SSH; Local localhost/Open In and provider credentials remain independent. Dead cloud dependencies do not remove general Local/Dev smoke. | electron access/SSH/forwarding suites; `scripts/__tests__/electron-local.test.ts`, development/release-environment and agent-smoke suites |

Native follow-up: open both Local owner types beside cloud; switch A→B→A and
accounts; exercise prompt/reconnect/Stop, files/Design/history, Git/PR, Open In,
shortcuts, split header and terminal focus. Repeat Local editing/history/restart
signed out/offline; restore networking for GitHub/provider work. Unreadable/full
optional cloud-cache storage must leave Local startup/commands available.

## Checkpoint throughput and bounded storage admission

Cold recovery captures the complete safe worktree. Small files use engine-only
batches of at most 64 items and 4MiB decoded bytes; large files retain the binary
object endpoint. The engine runs at most two requests concurrently, validates
each returned index, digest and size, and keeps at most 10,000 acknowledged blob
IDs for 15 minutes under the exact origin/workspace/generation/engine identity.
This cache only avoids repeated uploads after interruption. A successful content
append still requires current engine authority and a live, exact workspace blob
reservation. Append success or failure clears these hints.

Each batch uses one reservation transaction and one finalization transaction.
Encrypted conditional PUT and strong read-back occur outside database locks;
finalization rechecks engine authority, immutable object key, nonce and key
version. Admission counts pending, quarantined and deleting objects, rotation
reservations and detached deletion receipts. Reclaiming an interrupted old-key
upload first charges and queues the old key and chooses a fresh physical key;
it never reuses a fenced key or downgrades the key version.

Migration `0092` adds set-based quota admission and avoids rescanning an unchanged
workspace reservation ledger for every file reference. Content append publishes
ordered immutable events, current entries and exact reference-count deltas in a
bounded number of SQL statements. Tombstones precede replacement entries, so a
case-only rename does not depend on input order. Both hashed and legacy mutable
entry references are removed; immutable event references are retained. UUIDs
use the same canonical identity for storage locks, encryption and references.

Per API process, uploads share 32 object-I/O permits (at most 16 per small-file
batch), at most 64MiB of active
I/O payload and 64MiB queued payload, and at most 32 queued operations. Parsed
upload ingress reserves at most 128MiB, with at most eight batch bodies and four
active batch operations. Binary uploads use the same ingress and I/O budgets.
Body readers reject malformed headers before buffering, enforce a cancellable
15-second deadline, coalesce fragments into 64KiB slabs and periodically yield
the event loop. Storage I/O has a 25-second deadline, propagated to S3 operations.
Cancellation drains admitted work before buffers or capacity are released.
Metadata-backed reads enforce the exact expected ciphertext length before
allocating or consuming the response. These payload admission budgets are not
a process RSS ceiling. The shared production S3 connection pool permits 16
sockets; logical I/O permits include work waiting for a socket. Multiple batches
share bounded FIFO admission and can fill it; overload is retriable, without a
reserved per-workspace or interactive lane.
Content append chunks are bounded by both 10,000 mutations and 7MiB of serialized
mutations, leaving room under the 8MiB route body limit.

Local regressions exercise a 4,000-file baseline with repeated and distinct
contents, interrupted uploads, exact replay, quota rollback, revocation, key
reclaim, UUID casing, fragmented bodies and shared scalar/batch capacity. These
are algorithm and correctness checks; hosted cold capture/restore remains a
separate qualification gate, measured through the deployed API and object store.

## Verification and ownership

Run adjacent exact-path Vitest suites with `--maxWorkers=2` and use an isolated
DB for control-plane integration. Repository verification and platform-specific
gates are in `AGENTS.md`; release/qualification procedures are in
[qualification status](qualification-status.md), [release worker qualification](release-worker-qualification.md),
[runtime skew](runtime-skew-gate.md) and [native access](native-access-acceptance.md).
Shared protocol changes use `PROTOCOL_VERSION` and the mixed-version guard;
`LocalTransport` stays loopback-only and cloud work never relaxes its defenses.

Keep provider SDKs, provisioning and tenant authorization in the control plane;
device absolute paths, cache, SSH files and tunnel processes in desktop-owned
storage; and live workspace operation ordering in the engine. Update this source
map and `REPOSITORY-ARCHITECTURE.md` when those boundaries change.
