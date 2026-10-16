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
- An entry is loaded in its own system transaction by calling the same SQL
  function, so the cache cannot drift from the predicate. Only live, unfenced
  results are stored; every denial and every miss is answered by SQL.
- Each entry expires at the earliest clock deadline its predicate depends on:
  the engine lease, compute allocation `funded_until`/`provider_expires_at`,
  credit `covered_until`, a delegated credential's expiry minus 300 s, and
  account or organization entitlement `valid_until`; capped at 30 s.
- At most 10 000 entries; the oldest is evicted first.

## Invalidation

Migration 0152 adds the `zz_cloud_authority_cache` trigger to every table the
predicate or the loader reads. It sends `zeros_cloud_authority_cache` with a
scope only: `w:<workspace>`, `o:<organization>`, `u:<user>` or `*`. An
invalidation removes every entry in that scope.

- A heartbeat that only extends the engine lease does not notify: an entry is
  already bounded by the shorter lease it loaded. A shortened lease does.
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
