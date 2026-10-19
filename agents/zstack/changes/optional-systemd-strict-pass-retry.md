An unrelated sibling write in either qualified provider-owned optional-systemd
ancestor can change timestamps during the descriptor walk. Retrying the whole
strict pass repairs that reproduced race; it does not establish the cause of a
previous live refusal. Timestamp omission would also hide late ACL changes.

Keep fresh descriptor ACL observations, every structural/mount/absence fence,
and the immutable sealed-policy comparison before discarding a completed pass.
Use one original deadline, release all per-pass descriptors before backoff, and recheck
acceptance after diagnostic I/O. Best-effort logging must preserve outer signal
and timeout failures. Explicitly bounded anchor references may span backoff to
prove mount-object lifetime; fresh traversal observations remain mandatory.
The retained Python stability and diagnostic suites cover
these boundaries with real sibling writes and ACLs, plus deterministic races.
Permission-sensitive runs remove all capabilities; UID alone is insufficient.

Closed comparison histories report actual differing field names without raw
values. Repeated independent records remain valid. A valid old record plus a
dropped current write cannot identify the current call's outcome or retry count;
collectors must state that coverage is unknown. Seeded evals remove the retry and
the completed-pass policy gate independently. Parent assertion reds and the
first implementation's interruption reds are retained in the engineering receipt.
