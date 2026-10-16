- **An unsealed stop made every future wake fail.** Recovery needs a CP-selected,
  positively retired predecessor and an acknowledged ancestor, while retaining
  the newer FULL ledger. Activation and an unknown-coverage gap audit commit
  atomically; inherited requests never replay. Real CP deletion, rollback and
  stale-target tests cover receipt lifetime.
- **Helper-only tests missed the real history rebuild.** A controls/queue crash
  can leave prepared metadata under a new writer while canonical history still
  belongs to the original source. Test the complete projection at each cut,
  require fresh prepared custody and check immutable edit/delete and terminal
  receipts before minting proof. Retained regressions, the bug-fix playbook and
  `cloud-history-gap-recovery` encode this rule; no live IDs or artifact contents
  belong in evidence committed to source.
- **A successful recovery was not the last transition.** The next clean stop
  still rejected original edit/delete provenance because that writer had no
  seal. Bind prepare digests at CP activation and in later sealed inventories;
  exercise four activated unsealed handoffs and the next real sealed projection.
  Missing/changed prior links must refuse without modifying FULL or NORMAL.
