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

CI follow-up: capability advertisement also has exact-array assertions outside
the catalog suites. Include those handshake consumers when adding a capability;
update their explicit expected read-only list without weakening the checks that
Local engines must not advertise cloud command or timing authority.

Independent review found three gaps that the helper-level mocks missed: inherited
passive methods still used the Local socket through the real workspace facade,
semantic account equality revived Local reads after A→B→A, and map deletion
released byte charges before executing readers released the payload. Test the
exported bridge through `WorkspaceRuntimeClient`, fence Local admissions with a
binding lifetime advanced at the real account hooks, and retain aggregate byte
ownership until the last reader finishes. These are encoded in
`design-catalog-routing.test.ts`, `design-catalog-account-lifetime.test.ts` and
the retirement/default-budget cases in `catalog.test.ts`. The unchanged synthetic
independent proofs were six red contract assertions before these repairs; they
are review regressions, not escaped production incidents or capacity evidence.
