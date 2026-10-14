The first pool split passed saturation tests with one WorkOS session holder,
but review found an independent Computer retirement holder. Both could occupy
the two worker slots while their callbacks waited for a connection. An account
transaction lock could also pin the remaining slot behind a provider call in
another process.

Inventory every held client, including nested services, and hold independent
session locks concurrently across provider barriers in real Postgres. Assert
that both callbacks and another worker transaction progress before releasing
the holders. The retirement integration suite now covers this overlap and
account-lock deferral; boot tests verify the separate one-slot holder pool and
shutdown. The bug-fix playbook and seeded eval preserve the check. Count the
extra pool in deployment surge budgets, not only steady state.
