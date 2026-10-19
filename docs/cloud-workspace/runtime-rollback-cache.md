# Retained runtime payloads

A qualified base with `runtimeRollbackCacheVersion: 1` can remove the previous
runtime's payload before a sealed stop saves the VM. The exact archive remains
in the immutable runtime registry. The root install receipt and a small retained
reference remain in the VM, with a durable copy in the control plane. Ordinary
boot and setup validate that metadata without fetching or walking the evicted
tree. Current runtime verification and the hydration gate remain required.

This is a cloud base capability. Local Personal and organization-local
workspaces do not consult this cache. Existing bases retain their previous
behavior. Publishing a new base hash does not qualify it or change a workspace's
base pin.

## Eviction at a sealed stop

The lifecycle worker attempts maintenance only for its exact current-generation
stop, allocation, authority epoch and native source binding. It requires a
completed setup or runtime transfer, the latest engine's acknowledged native
seal, a successful checkpoint, a live hosted provider version, and no unresolved
runtime or generation transition. Unknown or short compute runway skips the
optimization. The budget ends at the earliest of the original stop dispatch
plus 120 seconds, the worker lease minus five seconds, and the provider/funding
deadline minus 45 seconds.

The root helper takes the existing setup, update, install and publication locks
in order. It verifies the current witness, previous pointer, boot and disk epoch,
and refuses unresolved switch/update journals. Before removing any payload:

1. The control plane verifies the exact immutable descriptor and archive length,
   then commits `cloud_workspace_runtime_rollback_refs`. Object I/O takes no
   database lifecycle lock; the scope is checked again afterward. A HEAD reply
   alone is not a retention acknowledgement.
2. A fresh authorization permits whole-host retirement. The existing host stop
   must positively prove that the complete host hierarchy is empty. A detached
   resident, running controller or unknown retirement cannot lose its payload.
3. Under publication serialization, both sides recheck authority. Root refuses
   mounted payload paths, writes `evicting`, removes only the exact previous
   tree, and writes `evicted`.

Receipt bytes, including `installedAt`, never change. The reference includes the
full runtime descriptor, base identity, original receipt and digest, retention
ID and originating allocation/epoch. It contains no artifact URL or credential.
An interrupted deletion leaves an explicit reference, which boot neither walks
nor treats as an incomplete ordinary install. Missing or corrupt current data
still fails verification. A maintenance failure permits the still-current paid
compute stop; a superseding wake prevents the stale stop.

## Explicit restoration

Selecting a retained target through the qualified runtime-transition path
creates one immutable `cloud_workspace_runtime_rollback_restores` deadline.
Preparation fetches that exact archive while the serving source remains live.
The original installer performs all archive, manifest, extraction, metadata and
tree checks. Root also preserves a restore journal tied to the transition,
retention ID and deadline. A completed stage is a proof of preparation, not an
execution grant.

The 240-second budget includes preparation, activation, enrollment and health;
retries and worker changes cannot reset it. Activation requires the matching
completed root journal and the same deadline. The control plane rechecks scope
and qualification after I/O, clamps activation to the remaining budget, and
accepts only the retained target receipt digest. Expired or late replies cannot
publish readiness or return enrollment material. The existing fallback to the
still-local serving source keeps its independent recovery deadline and exact
source receipt check.

The watchdog is armed before protected base validation can wait, and the
preparation transport shares the same deadline.

Retention does not override a revoked runtime/base qualification, source
retirement, admission policy or a resident handoff. The cache introduces no
automatic activation policy or user rollback trigger. Ordinary wake never
downloads a previous runtime as speculative recovery.

## Retention and qualification

Migration `0168_cloud_runtime_rollback_cache.sql` stores system-only immutable
references. Scoped workspace erasure removes restore rows before reference
rows; another workspace's pin survives. Runtime archives have no deletion API.
Any future object garbage collector must preserve every workspace reference and
unresolved transition. Release retirement does not release archive retention.

Before enabling a new base, qualify its exact base/archive pair with:

- A committed setup, acknowledged seal and whole-host retirement, followed by
  eviction and a provider saved-tree read proving the payload is absent while
  its exact metadata survives.
- Restoration from an empty cache, full qualification and enrollment using the
  original receipt, then two cold stop/resume cycles with files and history
  intact.
- Lost retention acknowledgement, interrupted deletion/extraction, missing or
  corrupt archive, expired deadline, stale authority and unresolved live roots.

Synthetic tests establish the local and control-plane contracts; they do not
establish the provider's saved-tree deletion or cold-restore behavior.
