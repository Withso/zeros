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
