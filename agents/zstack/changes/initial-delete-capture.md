# Initial setup Delete and complete record erasure

An ordinary Delete accepted before the first engine registration enrolled a
source without a boot or writer and could never request its final save. Initial
setup later became ready, but immutable enrollment and dispatch gates left the
same Delete blocked. Complete that exact first source once under a retained
receipt, preserve its original failure/retry facts, and require a real capture
and save proof before provider dispatch. Enrollment, writer activation and save
proof are separate events; initial setup is not evidence that saving is optional.

The full capture/provider/erasure regression also found file descriptors left
behind after successful record purge: a historical migration removed their
revision FK, so content-head deletion no longer cascaded. Erase the workspace's
file projection explicitly inside the existing authorized transaction, with both
workspace and organization predicates. Assert sibling bytes and rollback after
the DELETE actually executes, as well as target completion.

Encoded in migration 0179, the unchanged initial-setup regression, setup-worker
coverage, source/CLI/race controls, the end-to-end erasure test, independent
file-entry scope/rollback tests, and the two matching seeded eval cases. Local
and organization-local workspaces use neither control-plane path.
