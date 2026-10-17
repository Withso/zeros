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
| `device_stream` | retain | Transport choice; clients keep polling as before when off. |
| `credential_push` | retain | Transport choice; the poll remains as fallback. |
| `relay_over_uplink` | retain | Transport choice; the existing relay remains. |
| `presence_in_memory` | retain | Transport choice; database presence remains. |

`retain` keeps the last loaded value, still corrected by the safety refresh.
Use `off` for any new flag that relaxes a database check or a security
decision.

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
