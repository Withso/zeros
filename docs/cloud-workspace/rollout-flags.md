# Per-organization rollout flags

New cloud paths ship dark and are enabled one organization at a time: the
fixture organization first, then the owner organization. Local Personal and
organization-local workspaces never read these flags.

## Model

- Table `cloud_rollout_flags(org_id, flag, enabled, revision, updated_at)`
  (migration 0149). An absent row means **off**; every flag defaults to off for
  every organization. Rows cascade away with their organization.
- The code registry `ROLLOUT_FLAGS` in
  `apps/control-plane/src/rollout-flags.ts` owns the known names. Rows with a
  name the running code does not know are ignored, so a flag can be prepared
  before its code is deployed. Tracks append their flags to the registry.
- Each control-plane process holds a `RolloutFlagSnapshot`. Hot paths call
  `enabled(orgId, flag)`, which reads memory only. The snapshot reloads the
  enabled rows (one bounded, one-round-trip system statement) on every
  `zeros_cloud_rollout_flags` NOTIFY, on every LISTEN (re)connect and on a
  60 s safety refresh. A reload that overlaps a NOTIFY is followed by another
  reload, so a read taken before a commit is never the last one applied.
- The runtime role (`zeros_app`) can only read, and only in system context.
  Writes and the receipt table `cloud_rollout_flag_changes` belong to the
  migration owner.

## Behavior while the change feed is unavailable

The snapshot is *current* only after a reload that started and finished
while its LISTEN session was healthy. While it is not current (listener lost,
not yet connected, or the last reload failed), each flag reads as its
registered `whileFeedUnavailable` value:

| Flag | While unavailable | Why |
| --- | --- | --- |
| `authority_cache_shadow` | retain | Observation only; SQL still serves. |
| `authority_cache_enforce` | **off** | Relaxes a per-request SQL check. A missed "disable" must never keep it on, so it falls back to SQL. |
| `capabilities` | retain | Both paths are safe; flapping would bounce clients between them. Capabilities carry their own 5 min bound. |
| `realtime_uplink` | retain | Transport choice; the old HTTP paths stay available. |
| `device_stream` | retain | Transport choice; clients keep polling as before when off. Any organization with it on mounts the stream; an account streams while an organization it belongs to (member or live guest grant) has it on. |
| `credential_push` | retain | Transport choice; the poll remains as fallback. |
| `relay_over_uplink` | retain | Transport choice; the existing relay remains. |
| `presence_in_memory` | retain | Transport choice; database presence remains. |
| `runtime_connect` | retain | Additive endpoints; while off they answer 404 and clients keep `runtime/admission`. |
| `capability_actor_sessions` | **off** | Replaces short actor renewal with signed expiry. New admission/renewal and current-session readers must stop using it when the flag feed is not current. |
| `engine_lease_over_uplink` | retain | Changes which path renews the engine lease, not who may hold it: every renewal re-checks authority in SQL and the HTTP heartbeat stays as the fallback. A flip closes the affected uplinks (`1001 features_changed`), so flapping would bounce engines between the two paths. |
| `checkpoint_push` | retain | Transport choice for a timing hint; the heartbeat still delivers and fences every checkpoint request, and the long-poll remains as fallback. A flip closes the affected uplinks (`1001 features_changed`). |
| `cp_idle_stop` | retain | Moves who decides an idle stop, not whether the engine proves idleness: the engine cancels a request it cannot prove and its own timer resumes once the uplink is gone. A flip closes the affected uplinks (`1001 features_changed`). |
| `turn_journal` | retain | Transport choice: the engine keeps its turn journal either way and sends it only over an uplink that negotiated `turns.v1`. A flip closes the affected uplinks (`1001 features_changed`). |

`retain` keeps the last loaded value, still corrected by the safety refresh.
Use `off` for any new flag that relaxes a database check or a security
decision.

## Dependencies

A definition may name `requires` flags; the flag then reads off — in both
`enabled(orgId, …)` and `anyEnabled(…)` — unless every required flag is also
on for that same organization, transitively. `realtime_uplink` requires
`capabilities`: without capability keys and epochs the S2 handshake cannot
complete, so advertising or accepting the uplink alone would loop engines at
`auth.sync`. Enabling the uplink for an organization is therefore always the
pair: `capabilities` first, then `realtime_uplink`. `runtime_connect` also
requires `capabilities`: its endpoints issue S1 client capabilities.

`capability_actor_sessions` requires `capabilities`, `runtime_connect` and
`realtime_uplink`. It remains off until all CP readers and the exact qualified
engine implement the explicit mode; merely deploying the schema does not change
any timer. See [capability actor sessions](capability-actor-sessions.md) for the
N-1 fence, strict expiry, separate context proofs and rollback behavior.

`engine_lease_over_uplink` requires `realtime_uplink`: the uplink renews the
36 min engine lease (S2 `lease.v1`). Enable it only once every control-plane
service runs the HTTP heartbeat that never shortens a lease
(`greatest(lease_expires_at, now + 90 s)` in `setup-materials.ts`). An older
`api` would cut an uplink-renewed lease back to 90 s while the engine, which
trusts the uplink's report, skips its periodic beats, so the lease could
lapse and stop the workspace. Turning the flag off closes the organization's
`lease.v1` uplinks with `1001 features_changed`; the redial negotiates
without it and the engines return to the 10 s HTTP heartbeat. A lease the
uplink already renewed stays in force until it ends (up to 36 min), because
the heartbeat never shortens it.

Keep this flag off until every `api` serves the exact engine-exit withdrawal
endpoint, every `realtime` requires `exit.report.v1`, and the runtime has passed
supervisor exit, retry, setup/transfer enrollment and lifecycle-overlap drills.
The actual supervisor must be qualified: controller H can remain running while
it launches engine T, so qualifying T alone proves no exit reporter. A launcher
with an unsafe/full retry journal does not arm the declaration. New engines
under old supervisors and old engines under new CPs retain the legacy lease.
For rollback, disable the flag and retain the withdrawal API and supervisor
until already granted long leases are gone; a flag flip does not revoke them.

`checkpoint_push` requires `realtime_uplink`: `realtime` pushes queued
checkpoint requests (S2 `checkpoint.v1`) and engines pause their
checkpoint-hint long-poll while the push is active. The push is only a
timing hint: delivery, fencing and acknowledgement stay on the HTTP
heartbeat. New realtime selects it only when the engine also declares
`checkpoint.fallback.v1`: the engine requires an independent successful API
heartbeat at least every 60 s while push is active. Cached pongs cannot hide
a failed realtime pool. With the bounded port scan and HTTP request, a healthy
API discovers queued capture within 76 s; upload time remains in the same
five-minute deadline. Old engines keep their hint wait. Keep the flag off until
the independent-pool drill and qualified runtime checks pass. Turning the flag off
closes the organization's `checkpoint.v1` uplinks with
`1001 features_changed`; the redial negotiates without it and the engines
return to the long-poll.

`cp_idle_stop` requires `realtime_uplink`: `realtime` decides idle stops
from the engine's `activity.report` (S2 `idle.v1`), and the engine suspends
its own initiation while that holds. The engine still proves idleness before
it checkpoints: a request it cannot prove is cancelled, and unknown activity,
a lost uplink or an unavailable database never stops a workspace. Turning the
flag off closes the organization's `idle.v1` uplinks with
`1001 features_changed`; the redial negotiates without it, and the engine's
own idle timer decides again.

`turn_journal` requires `realtime_uplink`: the engine offers `turns.v1` only
on an uplink this flag allows. Turning the flag off closes the organization's
`turns.v1` uplinks with `1001 features_changed`; the engine keeps its journal
and sends the unacknowledged entries on the next uplink that negotiates the
feature. Rows already stored are kept.

## Changing a flag

`pnpm --dir apps/control-plane cloud-rollout-flag:manage` runs
`src/manage-cloud-rollout-flag.ts`. It requires the exact database migration
owner and an active platform-owner actor, and refuses personal or deleted
organizations and unknown flag names.

1. Write a change document (at most 16 KiB) and point
   `CLOUD_ROLLOUT_FLAG_CHANGE_FILE` at it:

   ```json
   {
     "operationId": "<new uuid>",
     "channel": "alpha",
     "orgId": "<organization uuid>",
     "expectedOrgSlug": "<organization slug>",
     "flag": "authority_cache_shadow",
     "enabled": true,
     "actorUserId": "<platform owner uuid>",
     "reason": "Shadow the authority cache on the fixture organization"
   }
   ```

2. Run without arguments: a dry run that prints `planSha256`, the previous and
   the next state, and changes nothing.
3. Run with `--execute` and `CLOUD_ROLLOUT_FLAG_PLAN_SHA256=<planSha256>`. A
   changed target refuses the stale plan. The change and its receipt commit in
   one transaction; the NOTIFY reaches every process at commit.
4. Re-running the same document reports `replayed` and changes nothing.

`channel` comes from `CONTROL_PLANE_ROLLOUT_FLAG_CHANNEL` and must match
`RAILWAY_ENVIRONMENT_NAME` when both are set (neither silently wins).
Executing against `"channel": "production"` additionally requires
`CONTROL_PLANE_ROLLOUT_FLAG_PRODUCTION_CONFIRMED=true`. Disabling is the same
document with `"enabled": false` and a new `operationId`. A document that
already matches the live state is refused as a no-op instead of writing a
receipt, and the organization must be active and cloud-enabled. The process
snapshot retries a failed reload with a 1–30 s backoff (below the 60 s safety
refresh), and a reload that a change hint waits on for more than 2 s drops
the feed-current mark, so a relaxing flag (`authority_cache_enforce`) cannot
stay on for a hung read.
