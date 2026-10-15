Two migration tests exceeded Vitest's default five seconds on an unrelated CI
change. Their small final assertions hid the cost of executing all 147 SQL
migrations in serial transactions. Both passed on idle local PostgreSQL; adding
10 ms per client-to-server chunk reproduced each unchanged test's timeout.

Only the runtime-ledger permissions and populated setup-upgrade cases now use
the same bounded 30-second budget as the existing intermediate-revision tests.
All SQL, ledger permissions, backfill values and lease-fence assertions remain;
no production timeout or suite-wide test default changes. The CI-red playbook
and timing scenario record the controlled-transit prerequisite, so an ordinary
idle pass is not reported as a successful reproduction. The eval is a scenario:
overlaying the fixed test onto its parent would also replace the failing timeout.
