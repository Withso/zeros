# A destructive tool's URL guard checked a name, not an address

- Symptom: the load simulator, which drops and rebuilds its database, accepted
  `?host=` query parameters at first (caught in review), and later
  `127.attacker.example` as a loopback host.
- Cause: pg applies query parameters over the URL host, and the loopback test
  was a `127.` prefix check on the host string, which a DNS name can satisfy.
- Rule: validate the effective target. Refuse query parameters, accept only
  loopback IP literals, resolve `localhost`, and allow-list the database name.
- Encoded in `skills/zstack-review/SKILL.md` (Security), the unit tests in
  `apps/control-plane/src/load-sim/database-guard.test.ts`, and eval
  `load-sim-url-guard-lookalike-host`.
