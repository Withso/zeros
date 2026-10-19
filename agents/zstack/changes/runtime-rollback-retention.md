# Retained payloads preserve identity and time

Symptom: reinstalling a saved rollback runtime changes its root receipt, and
giving activation a new deadline lets preparation extend the operation budget.

Cause: content identity, installation identity and operation lifetime are
different contracts. A remote HEAD reply also does not establish ownership of
the retained archive.

Rule: commit exact receipt and immutable archive retention before eviction.
Preserve that receipt through verified restoration, carry one nonrenewable
deadline through activation and health, and check after awaited work. Ordinary
boot must treat an evicted payload as metadata, including interrupted deletion.
Optional maintenance must not prevent an otherwise current paid-compute stop.

Encoded in the base rollback-cache and private-adapter tests, runtime transfer
and retention integration suites, and runner late-result tests. Scoped purge
tests retain another workspace's reference and the shared archive. Qualification
still needs a real saved-tree read and repeated cold resumes.
