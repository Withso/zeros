# Connection publication and an unreachable boot

- Symptom: reconnect could remain busy after the selected account expired,
  while another provider's abandoned publication stayed preparing indefinitely.
- Cause: publication included every initialized boot, including a revoked boot
  that had never received the provider. Its impossible pause/release held a new
  selection. Positive source retirement alone did not progress abandoned rows.
- Rule: distinguish an initialized potential recipient from a recorded holder.
  Only an exact permanently revoked boot with its original, immutable delivery
  journal and no conflicting adoption/material can be excluded from connection
  publication. Missing rows and lease expiry do not prove this. Retain positive
  release/retirement for every actual holder and all destructive mutations.
  Exercise first-delivery serialization and bounded closure through the actual
  Settings service; closure cannot silently select a new account.
- Encoded in the real-Postgres reconnect regression suite, the publication replay
  eval, and `docs/cloud-workspace/agent-connection-health.md`. Local credentials
  keep their separate native path.
- Fixture lesson: age engine registration and heartbeat together with its lease;
  keep timestamp constraints enabled. A missing binding fixture deletes only
  that binding, not an engine protected by a retained writer foreign key.
