# Keep progressive catalogs separate from complete snapshots

Symptom: a complete-snapshot validator accepted a first batch with an unknown
cursor/count field as the whole directory. An updated producer using that shape
could make an older consumer silently forget the remaining membership.

Cause: additive unknown fields cannot change the existing array's completeness
semantics. Catalog transport versioning and authored canvas versioning are
different contracts; the existing v2 scene index already represents stable
membership and geometry.

Rule: negotiate a distinct read operation and envelope, state partial coverage
explicitly, and bind continuations to exact revision, owner, intent and transport
lifetime. Do not raise source capacity or migrate authored files as a side effect
of adding a read API. Trace the actual writer before quoting its journal budget.

Encoded in `design-catalog-compatibility.test.ts`, the protocol catalog tests,
engine catalog/storage/service tests and the Design roadmap's catalog contract.
The partial-snapshot assertion was red before the guard; the new API examples
are feature qualification, not claims of an escaped production pagination bug
or measured 10k rendering support.
