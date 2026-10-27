# Unpublished workspace GitHub actions

- Symptom: repositories without a remote displayed the Git branch icon and
  offered Create PR in the workbench, Summary, sidebar preview and dashboard.
- Cause: empty origin metadata was treated as permission to show GitHub
  actions, and dashboard actions considered changes without remote capability.
- Rule: require a known GitHub destination for creation, including its direct,
  draft and manual variants. A missing origin can also mean a configured remote
  with another name; honor that destination using the existing exact-repository
  local-ref catalog. Share those reads, retain confirmed
  metadata on failure, and never wake cloud workspaces for a badge or action.
- Encoded in the workspace-header, PR-row, CreatePrButton, Summary and card
  regressions, plus the Summary browser smoke's publication, owner-switch and
  alternate-remote scenarios. Review also proved that recovery and archiving
  remain available without a GitHub remote.
- CI caught a substring host check in the browser catalog fixture. Fixtures
  must use the existing parsed-host predicate too; the Summary smoke now
  rejects lookalike hosts and GitHub text in credentials or paths while
  accepting the supported HTTPS and SSH forms.
