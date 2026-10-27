# Keep cloud connection status out of tab error banners

- Symptom: a workspace lifecycle banner covered every workbench tab, and
  suppressing that banner alone could leave a connection failure disguised as
  a file/Git read error or suppress its existing app toast.
- Cause: availability, primary/secondary read failures and toast visibility
  shared presentation ownership even though the sources had different scopes.
- Rule: when changing a status surface's ownership, trace both the shared
  status and read-error paths, preserve unrelated resource failures and retry
  behavior, and verify where the existing fallback reports the failure.
- Encoded in `tab-status-cloud-availability.test.ts`,
  `workbench-availability.test.ts`, `scripts/ui-smoke-workbench-status.mjs`, and
  `docs/design-system.md`. Local Personal, organization-local and cloud are
  covered; workspace status decisions and wake authority are unchanged.
