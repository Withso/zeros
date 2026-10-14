The Pro-sharing pagination case hit Vitest's five-second default while creating
101 real accounts, invitations and acceptances sequentially. Its direct
`pg.Pool(max: 6)` bypasses the API pool factory, and its transaction helpers were
unchanged by the pool-bulkhead patch. A local PostgreSQL proxy adding 2 ms to
each client-to-server chunk reproduces the timeout without API limits.

The existing CI-red playbook applies: trace changed-code reachability before
attributing a timeout, then qualify the fixture under bounded database delay.
Only this pagination case gets a 30-second test budget. Its 101 real workflows,
100+1 page boundary, unique guest count and writer count remain asserted; the
production pool, query and acquire deadlines stay unchanged. The companion
eval records this case separately from the earlier retention fixture.
