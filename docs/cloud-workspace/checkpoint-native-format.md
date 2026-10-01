# Native cloud checkpoint recovery

The engine owns checkpoints independently of the compute provider. A provider
snapshot is an image/provisioning optimization; recovery uses the control-plane
record, encrypted objects and this format. Runtime implementation and deployed
image qualification are separate release gates.

## Publication and compatibility

A v2 manifest contains the complete safe working-tree projection, its Git HEAD,
the private Design selection, and a native archive. The control plane atomically
pins the manifest, projected files and every native chunk to one checkpoint.
Blob availability also requires an upload reservation or existing reference for
the same workspace; organization membership and a known blob UUID are not an
upload capability. Expired unreferenced upload reservations cannot publish new
content. Retries use the canonical sorted set of chunk identities.

Native chunks use `checkpoint_artifact` references with
`reference_id = <checkpoint UUID>:v2`. These identifiers are persisted contracts.
The recovery capability binds one checkpoint, organization, generation, setup run
and execution fence. It authorizes only that checkpoint's immutable files,
manifest and pinned chunks. Retention, deletion, reference accounting and object
storage limits apply to the complete set.

Setup requests `GET .../setup/recovery/manifest?version=2`. The paginated response
includes the manifest and artifact `{blobId, contentSha256, sizeBytes}` descriptors.
Pages must agree on all metadata. A v1 client receives `409
recovery_format_unsupported` for a checkpoint containing native chunks. Existing
v1 checkpoints retain their original response and idempotency digest contracts.
An older runtime must never report success after restoring only the files from a
v2 checkpoint.

The manifest and recovery pagination remain v2. Within the manifest, native
archive v1 contains a complete `git-pack/objects.pack`; native archive v2 adds
`gitRemoteBase: { commits: [...] }` and immutable
`git-pack/remote-<sha256>.pack` files alongside `objects.pack`. These packs are
self-contained, not Git thin packs with external delta bases. Every base pack
uses the same pinned `checkpoint_artifact` chunks and limits as the local pack.
Native-v1 readers reject archive v2 before publishing files, rather than
mistaking an unpushed-only pack for complete Git history. Full-pack fallback
continues to emit archive v1, and both versions remain readable by current setup.

## Captured state

- The Git pack retains objects reachable from refs, reflogs and the index. Raw
  index and shared-index files preserve staged changes, intent-to-add and merge
  conflict stages. HEAD, refs, reflogs, shallow boundaries, stash and the selected
  merge/rebase/sequencer metadata are retained. Git config, hooks, credentials,
  alternates and lock files are excluded. Original Git object history is retained
  as object history; the working-tree secret-name filter does not rewrite commits
  or staged objects.
- For a proven canonical origin, `objects.pack` excludes the recorded remote
  commits and their trees. A base must have an origin fetch/push tracking reflog
  and lie beneath a local HEAD, branch or stash. No remote, no tracking refs,
  unproven tracking tips, mismatched fetch/push destinations or an unsupported
  remote fall back to the full pack. Unproven refs outside an otherwise proven
  base stay in the local pack. Operation-only object roots such as `ORIG_HEAD`
  are included even when no ref or reflog names them.
- A bounded object-size preflight conservatively checks that separate base/local
  packs fit the byte/chunk budget before uploading Git packs. If it cannot prove
  that bound, capture uses the complete pack instead, retaining its cross-history
  compression rather than losing a recovery point to split-pack expansion.
  Encoding/base-selection differences do not invalidate unchanged-state checks.
- Omitting pushed history cannot make a mutable remote the recovery authority.
  Its objects are therefore archived once in an immutable base pack; subsequent
  captures reuse its chunk descriptors without repacking or uploading it.
  Forward pushes add only the newly published objects in another base pack.
  A rewrite or changed shallow boundaries rebuilds that base rather than reusing
  an unproven ancestor set. The optimization is bounded to 256 base packs;
  saturation falls back to a complete pack for that capture. Each checkpoint
  pins its complete set, with no dependency on another checkpoint surviving.
- Claude project JSONL history, Codex rollout JSONL history and the four Cursor
  workspace stores are selected explicitly. Provider credentials, account
  configuration, global caches and the rest of each home are excluded. Credentials
  must be admitted separately after recovery. Provider resume compatibility needs
  qualification against each pinned native harness.
- Private Design storage and transaction-recovery records use the canonical
  workspace key. The selected `directory_id` and legacy directory pointer are
  normalized separately. Other `settings.local.toml` fields are not copied.
  Ignored legacy `.zeros/design/`, `.zeros/design-dir.toml` and
  `.zeros-canvas.json` remain recoverable without enrolling other `.zeros` state.
- `.context/attachments` is an explicit native recovery scope. It does not enroll
  the rest of `.context`, ignored dependency trees or arbitrary home directories.

Git capture uses the documented
[pack-objects](https://git-scm.com/docs/git-pack-objects) object-selection flags;
restore validates the pack using
[index-pack](https://git-scm.com/docs/git-index-pack). Repository Git commands use
the qualified worker identity, with hooks, filesystem monitors, lazy fetch and
network protocols disabled during native capture and pack import.

## Bounds and restoration

Files are streamed into 16 MiB chunks with backpressure. Native capture is bounded
to 2 GiB, 25,000 files, 128 MiB per non-pack file and 1,024 chunks. Descriptor-bound
Linux reads reject links, special files, hard links, path traversal and changing
inputs. Inventory and file hashes are confirmed before commit. These native
bounds are separate from the current working-tree scanner's 64 MiB per-file and
512 MiB total limits. Capacity or consistency failures prevent a durable receipt;
they do not turn an incomplete archive into successful recovery.

Fresh setup verifies chunk and file hashes before publishing native files. It
first tries to clone the recorded repository revision; an exact commit pin must
match the fetched HEAD. A failed remote fetch can proceed only with an approved
native checkpoint, whose immutable packs also contain the omitted base objects.
Thus a remote force-push, deleted branch, collected history or unavailable remote
cannot invalidate a previously durable native checkpoint. A working-tree-only
checkpoint still requires its verified remote base.

Setup imports every base/local pack under the worker identity, installs the
captured shallow boundaries, verifies ref/reflog/index and operation-root
connectivity, replaces cloned ref/index metadata,
removes the obsolete cloned working tree and applies the complete projection.
The recovered HEAD may be an unpublished commit, so it is checked against the
checkpoint rather than required to equal the initial remote fetch. Empty Git
reference directories are reconstructed for detached and packed-reference
repositories. On later wakes, a completed setup journal accepts user-created
commits while continuing to bind the repository, generation and settings. A
partially completed setup still requires its original HEAD. Native paths
are reconstructed from deployment-owned roots; the archive cannot select an
absolute host destination. Worker history and attachments receive worker ownership.

Local regressions cover unpublished HEAD, staged/unstaged and `AD` paths, stash,
conflict stages, shallow metadata, stale clone refs, chunk corruption, unsafe
paths, private Design selection and credential exclusion. The opt-in
`cloud-checkpoint-recovery-root.test.ts` additionally exercises real Linux
`setpriv`, ownership and HTTP downloads in a disposable `/srv/zeros` fixture. It
refuses to replace an existing runtime directory. These tests do not replace
allocation-loss, native-agent resume, object-store disaster recovery or macOS
qualification.

The generation endpoint accepts `{ "operation": "recover", "sourceGeneration":
N, "checkpointId": "UUID" }` for a failed, stopped or archived workspace. A
workspace still labelled ready/busy can also recover after its engine lease
expires, provided no current starting/ready engine has a live lease. The
workspace lock orders this check with heartbeat and registration. The checkpoint must be the current durable checkpoint of that same workspace and
organization. Recovery preserves entitlement, owner, resource-headroom and
idempotency checks. It pins the checkpoint to the candidate before revoking the
source authority, drains the old allocation and then creates a fresh generation
using the current qualified image. It does not fabricate a successful final
checkpoint request from an unavailable engine. Healthy workspaces use normal
upgrade/rollback so their final work is captured first.

A confirmed missing allocation cannot be silently recreated under its old
generation number. The reconciler retires its authority and reports
`provider_resource_lost`; an unconfirmed provider 404 remains retryable and does
not allocate a duplicate VM. Recovery uses the explicit checkpoint selection
above. Accepted deletion and confirmed physical erasure remain separate states.

After a healthy durable-record heartbeat, the engine schedules a recovery point
every five minutes. One capture runs at a time with a one-minute deadline.
Periodic capture does not retire agents, terminals or development servers.
Changing inputs defer publication and retry after a minute; the previous durable
checkpoint remains available. This interval is a scheduling policy, not a
guaranteed recovery-point age while writers keep changing files. Lifecycle/manual
capture waits for that bounded lane, quiesces writers and takes the final snapshot.

An unchanged periodic tick creates no uploads, file events or new checkpoint.
The engine compares the current durable checkpoint identity/revision, complete
working-tree projection, private Design selection, Git metadata and native
histories, and checks Git object connectivity. It confirms the native inventory
and hashes and rechecks the working tree before skipping. Repacking the same
objects alone is not a change. Lifecycle and explicit captures always publish,
even for an unchanged workspace.

A bounded, engine-private `cloud-checkpoint-cache/` under the data directory
stores the last confirmed fingerprints and immutable base descriptors. It is
keyed by Organization/workspace and admitted only for the exact current durable
checkpoint. Setup seeds it only after verified recovery, so restarts and new
generations can reuse base chunks. Missing, corrupt or mismatched cache state
forces a verified capture instead of a skip. This cache is not a recovery
authority or a native archive scope. An idle workspace's checkpoint timestamp
can consequently be old while its state is still fully covered.

## Retention and storage

The existing control-plane pruning job retains every checkpoint from the last
hour, the newest durable checkpoint per UTC hour for 24 hours, and the newest
durable checkpoint per UTC day for 14 days (or a shorter `checkpoint_days`
policy). Current checkpoints, generation recovery pins, exports, legal holds and
unexpired `retention_until` override the tiers. Pending lifecycle/fork requests
also remain protected; completed delivery requests are released after 24 hours
once no live intent needs them. Invalid checkpoints never displace durable tier
winners. Pruning releases manifest/file/native references, including the persisted
`<checkpoint UUID>:v2` identities, before normal blob collection.

Beta and Production explicitly set
`CLOUD_WORKSPACE_OBJECT_RESTORE_WINDOW_HOURS=336` (14 days). The code default
remains 48 hours. This is a dereferenced-object recovery window, not permission to
delete a referenced base pack; physical deletion and permanent fencing still
control release of the Organization's reserved bytes.

For history of N MB and M new commits/day, poor fixed-chunk reuse can retain
roughly `90 * M * N` MB of Git packs under the former 90-day policy, up to
`90 * 288 * N` MB if every five-minute capture shifts the history chunks.
The optimized steady state keeps roughly N MB of shared pushed history plus
local-only packs at at most about 50 ordinary tiered recovery points and newly
dereferenced packs awaiting collection. Protected checkpoints and working-tree,
history/transcript and file-event storage are additional. These are estimates;
remote-base rebuilds, fallback captures, changes per tick and the restore window
must be included in measured deployment costs.

## Qualification gates

Submodule/LFS recovery beyond the declared scopes, restored native-agent resume
and allocation-loss qualification remain explicit completion gates. Periodic
capture and recovery-point age also require live load and cost measurements.
