# MCP configuration: prove storage, admission and connection lifetime

Symptom: a redesigned editor could save into a different project and return to
the original list, remember a connection after a secret changed, or display a
cold organization with no repositories. OAuth denial and shared-flight
cancellation also left unrelated clients waiting or failed.

Cause: navigation used the original scope, verification keyed only public
configuration, repository reads skipped native admission refresh, and an
authorization flight inherited its first observer's cancellation lifetime.

Rule: test the production editor through its native/API boundary as well as
the model. Bind verification to secret edits and durable definition revisions,
publish the saved destination with navigation, and warm authenticated catalog
admission before consuming it. Separate a shared operation's lifetime from
each caller's wait; retire removed entries before queued work can publish.

Encoded in the retained Local/organization browser smoke, credential-vault
transactions, scoped-gateway race tests, CP OAuth denial/custom-discovery tests
and worker shared-authorization cancellation regression. These are in-branch
findings, so no escaped-main eval case is added.

Native review found that closing a probe's HTTP transport did not terminate
its remote session, a global retirement epoch cancelled unrelated owners,
and a cached rejected disposal promise prevented cleanup retry. Send the SDK's
session DELETE within the original deadline, fence each queued admission by
its own owner, and retain cleanup handles while allowing proof to be retried.
Real loopback probe tests and native launcher lifetime regressions encode all
three cases. Saved legacy transports must also reach the connection-check
effect even when the creation menu no longer offers them; the production
editor browser regression covers that distinction.

Environment: a custom-user PostgreSQL cluster may lack the conventional
`postgres` role used by development-profile fixtures. Verify that isolated
fixture prerequisite before treating the failure as a product regression.

The Tools extension keeps discovery separate from policy: complete catalogs
include disabled names, unknown differs from authoritative empty, and failed
refreshes retain only the exact configuration's names. Only gateway-enforced
paths expose editable switches; policy edits must not restart discovery or
discard restrictions on currently absent names. Native/CP real-transport tests,
model/cache tests and the production Local/organization smoke encode these
rules, including late responses, read-only members and bounded catalog rows.
Switching a restricted remote draft to STDIO must omit its remote-only policy
from the saved process definition; a retained model regression covers this
strict cloud-schema boundary and preserves the unsaved HTTP choices.
Adding catalogs to a status cache also changes its memory cost: reuse the
shared weighted budget, in addition to its entry count, and test eviction
without dropping the active or newest complete snapshot.
The browser bridge fixture copies tool arrays like real IPC; sharing its mutable
input array hid a refreshed name behind a memoized projection. Toast captures
also honor the shared six-second error lifetime instead of a shorter wait.

Full PR CI also reaches engine-level lifecycle fixtures, beyond the MCP module
tests. When adding owned services, update prototype-backed fixtures with those
services and retain every cleanup/failure assertion; cover scoped cleanup and
pending probe cancellation too. An existing explicit gateway setter remains an
active-endpoint contract even without a project resolver. Keep that fallback
separate from retained empty project listeners, and test both collision
reservation and the absence of cross-project fallback. The engine startup,
stop, catalog and per-session MCP regressions encode these checks.

Run stream lifecycle regressions on every supported server/CI Node major.
Node 24's guarded Web-stream adapter masked queued data arriving after cancel
on Node 22. Retain deterministic buffered body/reader cancellation and real
socket cleanup, and treat unhandled errors as failures even when every
assertion passes. The safe-fetch regressions reproduce both supported majors;
the supported Transform destroy hook stops readable flow before close cleanup.
Use distinct MCP protocol type names so they cannot shadow Web Request globals
in analysis; the worker type alias correction preserves emitted JavaScript.

OAuth bindings are random opaque identity markers. Compare the complete
canonical identity against authenticated decrypted material before reusing a
saved or admitted-attempt marker. Independent creation events receive distinct
markers; restoring a historical configuration creates a fresh marker. Historical
SHA/HMAC values stay opaque, so key rotation and retirement do not revoke an
unchanged grant after its envelope has been re-encrypted. A supplied sign-in
attempt still needs exact actor, organization, live state, server and revision
admission. Compare canonical stored UUIDs, keep draft reads free of mutation
locks, and reconcile a validated attempt only inside the save transaction.
Owner and repository changes independently revoke grants. Real-PostgreSQL
regressions cover marker lifetime, rotation, historical values, retired keys,
refusal rollback, uppercase IDs and unchanged-member access.

A generic password-hash analysis can flag keyed HMAC when credential content
enters its input. Keep identifier generation independent of credentials; helper
indirection and algorithm substitution do not establish that boundary. Retain
observable behavior regressions and wait for the separate CodeQL alert check
as well as the successful analysis workflow.
