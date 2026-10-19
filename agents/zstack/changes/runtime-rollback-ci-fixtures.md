# Runtime rollback verification must reach the intended boundary

A corruption regression failed in PR CI before it could verify the current
payload: the fixture tried to overwrite an installed 0555 file. Local checks
had passed because the nonzero-UID process retained filesystem-bypass
capabilities. The new rollback guide also missed the exact documentation
inventory despite being linked from its related runtime guide.

Temporarily enable fixture writes, restore the expected mode in `finally`,
keep the original byte length, and require the closed `file_digest` failure.
Reproduce Linux permission failures after dropping capabilities. Register new
guides in both the owning index and the unchanged exact layout assertion.

Encoded in the CI-red playbook, the retained rollback-cache regression,
`repository-layout.test.ts` and the cloud guide index. The unprivileged Python
suite and the bootstrap and layout Vitest suites must pass. These were caught
before merge; no escaped-bug replay is claimed.
