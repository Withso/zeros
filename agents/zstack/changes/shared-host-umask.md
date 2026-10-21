# A group-writable umask fails the Dev environment suites

On a shared host with `umask 0002`, 28 tests failed across four suites:
`dev-auth-profile`, `dev-environment-dependencies`, `dev-environment-setup`
and `dev-environment-state`. The errors read "Development state requires
private, user-owned files" and "Unsafe Zeros Dev auth profile directory". The
same suites pass with `umask 022`, which matches CI. Rerun them that way before
reading the failure as a regression (`playbooks/ci-red.md`).
