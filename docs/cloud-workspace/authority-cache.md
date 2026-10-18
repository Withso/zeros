# Engine authority cache

Track B, slice B1. Cloud workspaces only; Local Personal and
organization-local workspaces never reach these paths.

`apps/control-plane/src/cloud-workspaces/engine-authority-cache.ts` keeps an
in-process copy of the engine authority that
`cloud_workspace_engine_authority_current` computes per request today. It is
the authority source for the S1 verifiers on `api` and `realtime`
(step 8: current generation and engine instance), and it can serve
fence-free reads before then.

## Entries

- Key: workspace, organization, generation, engine instance and
  `workosEnabled`. The value carries the authority epoch (`wa`), the account
  user, the heartbeat token hash, enrollment state and the engine lease.
- An entry is loaded in its own system transaction by calling
  `cloud_workspace_engine_authority_snapshot` (0151): the body of
  `cloud_workspace_engine_authority_current` with only its row locks removed,
  a derivation the integration test pins. The cache cannot drift from the
  predicate, and a load takes no row locks, so it never waits for a heartbeat
  or makes one wait. Only live, unfenced
  results are stored; every denial and every miss is answered by SQL.
- Each entry expires at the earliest clock deadline its predicate depends on:
  the engine lease, compute allocation `funded_until`/`provider_expires_at`,
  credit `covered_until`, a delegated credential's expiry minus 300 s, and
  account or organization entitlement `valid_until`; capped at 30 s.
- At most 10 000 entries; the oldest is evicted first.
- An enforced fence-free read reports `confirmedUntilMs` as the earliest of
  now + 10 s, the engine lease and the entry's deadline. No hint fires when a
  funding, credential or entitlement deadline passes, so a caller must not be
  told the authority holds beyond it.

## Invalidation

Migration 0151 adds the `zz_cloud_authority_cache` trigger to every table the
predicate or the loader reads. It sends `zeros_cloud_authority_cache` with a
scope only: `w:<workspace>`, `o:<organization>`, `u:<user>` or `*`. An
invalidation removes every entry in that scope.

- A heartbeat that only extends the engine lease does not notify: an entry is
  already bounded by the shorter lease it loaded. A shortened lease does.
- Credit metering and top-ups on `managed_compute_credit_reservations` do not
  notify while `covered_until` moves later and `reserved_micro_usd > 0` keeps
  its truth value; the predicate reads both. A state change, a shortened
  `covered_until` or an exhausted reservation notifies.
- A port-scan heartbeat stamping `cloud_workspace_generations.ports_observed_at`
  (UI metadata the predicate does not read) does not notify. Before this
  exemption every such heartbeat cost one notifying commit per active
  workspace and flushed that workspace's entries.
- The derived coverage test also checks that every column an exemption skips
  is either unread by the predicate or covered by such a guard.
- Every notifying commit takes PostgreSQL's cluster-wide notify queue lock and
  holds it through its commit WAL flush, so notifying commits serialize across
  the whole database, not per channel. Identical hints dedupe within a
  transaction, and the triggers skip writes that cannot change a decision for
  that reason. `pnpm load:db`
  counts authority hints separately ("Authority hints/s"), includes them in
  "Notify commits/s", projects notifying commits at 100, 500 and 1000 active
  workspaces, and enforces
  `authorityCacheNotificationsPerActiveWorkspacePerSecond` in `budgets.json`.
- A load is discarded if any hint for its workspace, organization or user,
  or a flush, arrives while it runs, so a read taken before a commit is never
  stored after that commit's hint.
- Entries are trusted only while the LISTEN session that preceded their load
  is connected. Listener loss flushes everything and disables lookups until
  the next connection.
- `engine-authority-cache.integration.test.ts` derives the table set from the
  live function definitions and fails if an input table lacks the trigger, or
  if a new clock comparison appears that the loader does not bound.

## Flags

| Flag | Effect |
| --- | --- |
| `authority_cache_shadow` | `assertCurrentCloudEngineAuthority` and `readCurrentCloudEngineAuthority` still decide with SQL; afterwards the cached decision is compared in memory. |
| `authority_cache_enforce` | `readCurrentCloudEngineAuthority` (the fence-free read) answers an allowed decision from memory, without SQL. Also enables shadow comparison. |

`assertCurrentCloudEngineAuthority` is never served from memory: its row
locks are the mutation fence for appends, checkpoints and stops.
With the enforce flag off, its feed lost (it reads off), or the cache feed
lost, SQL decides exactly as before.

## Shadow statistics

`EngineAuthorityCache.stats()` returns counters only; a periodic log line
prints the same counts and never keys, tokens or values.

- `agree`, `miss`: compared and agreed; no usable entry (a load starts).
- A disagreement waits 2 s for in-flight hints, then re-reads committed state:
  - `converged`: a hint removed the entry meanwhile;
  - `transient`: committed state matches the cache (the caller's transaction
    saw its own uncommitted writes);
  - `mismatchCacheAllows` / `mismatchCacheDenies`: the entry was stale and no
    hint removed it. The entry is dropped. Enforcement requires both to stay
    at zero on fixture and owner traffic.

## Uplink auth snapshots

`DatabaseUplinkAuthSource` (realtime/uplink-auth-source.ts) serves the S2
`auth.sync` snapshot from the same authority facts. Its scope is the
workspace's own principals: everyone with current access, plus anyone who
lost access to that workspace inside the 36-minute revocation retention
window, recorded by `cloud_capability_access_losses` in the committing
transaction. Nothing about other workspaces' members is sent to a VM.

`auth.sync` travels in one S2 control frame (64 KiB). The source refuses an
encoded snapshot over `UPLINK_AUTH_SYNC_MAX_BYTES` (60 KiB, leaving the frame
envelope headroom) with `UplinkSnapshotTooLargeError`, counted as
`counters.oversizeSnapshots`; the server then parks the engine with
`internal_error` instead of sending a frame the engine would reject and
reconnect-loop on. At roughly 126 bytes per principal with two devices the
bound holds about 480 principals per workspace; beyond it, shrinking the
snapshot (omitting principals unchanged inside the window, or a chunked
sync) is a contract minor tracked with the contract owner.

## Capability placement (S1 step 8)

`api` (engine tokens, pinned `zeros:api`/`engine`) and `realtime` (client
tokens on relay admission, pinned `zeros:realtime`/`client`) verify through
`ServiceCapabilityVerifier` (cloud-workspaces/capability-service-verifier.ts),
which wraps the shared verifier. Step 8 compares the token's `gen` and `ein`
with the workspace's current placement, never with the request:
`EngineAuthorityCache.placement()` answers from memory while the cache is
enforcing for the organization (the one usable, unrevoked, enrolled entry;
none or more than one falls through), and otherwise `readCapabilityPlacement`
reads the current generation and its one live engine instance. Two live
engines in one generation (a handover) give no instance, so an engine-bound
token fails closed until the handover settles.

With `capabilities` on, the engine command mirror and seal routes
(`engine:history.write`) check a token sent in `X-Zeros-Capability`; the
heartbeat bearer stays the mutation fence in v1, and a request without a
token keeps today's path so engines that predate engine tokens keep working
during the rollout. With the flag off nothing changes.

In this release `ServiceCapabilityVerifier` does not run the S1 verifier
epoch bootstrap: it never loads current epochs or revocations, so step 10
compares a token only with epochs seen in earlier tokens in the same
process and step 11 never rejects. On `api` this is defense in depth while
the heartbeat bearer remains the engine fence. Relay admission on
`realtime` (track C5) must load the workspace's epochs and revocations
before it admits a client token.

## Capability signing keys runbook

S1 signing keys are Ed25519, sealed at rest with the dedicated
`CLOUD_CAPABILITY_KEYS_JSON` keyring (never the settings keyring) and stored
as rows in `cloud_capability_signing_keys`. The published set is at most
`next` + `current` + `retiring`; only `current` signs. Every change goes
through `pnpm --dir apps/control-plane cloud-capability-key:manage` with a
change document in `CLOUD_CAPABILITY_KEY_CHANGE_FILE`, dry-run first,
`CLOUD_CAPABILITY_KEY_PLAN_SHA256=<planSha256>` and `--execute` to apply,
exactly like the rollout-flag command: both channel sources must agree
(`CONTROL_PLANE_CAPABILITY_KEY_CHANNEL` and `RAILWAY_ENVIRONMENT_NAME`), and
production execution needs
`CONTROL_PLANE_CAPABILITY_KEY_PRODUCTION_CONFIRMED=true`. Every executed
change writes a `cloud_capability_key_changes` receipt; a replayed
`operationId` naming another change is refused.

Normal rotation:

1. `create` with a fresh `kid` (`cap-<yyyy>-<mm>-<suffix>`). The key enters
   `next` and is published in the JWKS immediately.
2. Wait at least 24 h (skipped for a channel's first key: there is no
   `current` to overlap) so every verifier has seen `next`.
3. `activate`: `next` becomes `current`, the old `current` becomes `retiring`
   and stays published another 24 h.
4. `retire` once the overlap elapsed: `retiring` becomes `retired` and leaves
   the JWKS.

Emergency: `revoke` removes a key from the published set at once; verifiers
reject its tokens on their next key-set refresh (push, or the 5 min JWKS
refetch while push is down). Issuance fails closed (503) until a replacement
is created and activated, so stage the replacement first when the revocation
is precautionary.

Keyring rotation (`CLOUD_CAPABILITY_KEYS_JSON`) rotates only the envelope:
add the new version, set `CLOUD_CAPABILITY_CURRENT_KEY_VERSION` to it, and
keep every version that still seals a live key; a sealed key is only ever
opened with its recorded version. Rotating the keyring never reseals or
changes a signing key, so it needs no publish window.
