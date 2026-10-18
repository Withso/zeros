# Capability actor reader fences

Symptom: a new persisted session kind would still satisfy older actor readers
for its first 30 seconds. A read-only owner's role could also supply run funding
through detached confirmation even though its signed token lacked that scope.

Cause: freshness is read indirectly by commands, credentials, native Git and
contexts. A kind tag and a longer deadline do not change those readers. Role,
socket lifetime, context proof and source-auth authority are separate facts.

Rule: inventory every direct and indirect freshness reader before changing its
authority source. Make unsupported persisted kinds fail closed in N-1 SQL;
apply exact scopes at every authority conversion and retain independent finite
context proofs. SECURITY DEFINER guards must reject NULL as well as false.

Encoded in capability-actor-sessions.integration.test.ts: frozen N-1 queries,
operation-scope parity, read-only owner funding, source/key/epoch revocation,
real row-lock and held-reply races, SQL/RLS constraints and concurrent renewal.
Capability-actor-contract.test.ts keeps the new strict mode separate from the
legacy bearer response and verifies feed-loss/dependency behavior. These are
new feature guards, not an escaped-production bug or a live rollout receipt.

Independent review found two missing bounds before activation. New internal
routes must join the body-limit middleware before parsing, even with rollout
disabled: a syntactically shaped bearer is not authentication. Retain both
declared-length and streaming oversized requests through the assembled app.
Expired renewal is a new live-capacity admission. Share the same serialized
capacity fence with admission before row/source/key waits; ordinary live
renewal retains its existing slot. Test expired recovery at capacity, renewal
of a live row at capacity, and two recoveries contending for the last slot.

CI exposed two integration gaps: capacity locks lacked the registered static
SQLCommenter purpose, and a populated migration fixture called current actor
readers against schema 0141. Keep lock purposes closed and independent of lock
keys. Pin historical fixture writes to their old schema; exercise current
services again only after applying the upgrade. `database-lock-tags.test.ts`
enforces the tags, and `data-purge-migration.integration.test.ts` preserves the
complete historical actor graph across migration before purging both old and
new service-backed workspaces.

The full sweep also exposed a local fixture mismatch: an OS-user-initialized
PostgreSQL cluster had no `postgres` role, which the hosted Dev membership
guard names explicitly. Match CI's role fixture before that check; never relax
the production privilege guard to accommodate a differently initialized test
cluster. Preserve the environmental failure and the identical rerun as evidence.
