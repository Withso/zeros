# Local Summary Git status

- Multiple mounted Git controls could each claim the same workspace operation.
  A component-local guard ends at remount, while a request or agent turn does
  not. Summary, Create PR and the PR row now share an exact-workspace claim;
  stale completions cannot release its successor. Archive retains its explicit
  ability to replace a prompt it stops. The claim suites and browser action
  smoke cover these boundaries.
- Upstream tracking counts cannot describe distance from the selected PR base,
  and GitHub does not supply that comparison for every draft or unpublished
  branch. The opt-in Local status comparison prefers the configured remote's
  selected base, preserves missing history as unknown, and does not fetch or
  mutate Git. Engine integration tests cover stale local bases, missing bases
  and detached HEAD; Summary tests keep net uncommitted counts separate.
- A primary split control's clipped shell hid its focus cue, and a spinner
  changed a text button's accessible name. Explicit opaque focus styling and
  stable button labels are verified in both themes by the real Summary smoke.
- Retaining a failed refresh's last confirmed facts also needs a reachable
  Retry action. The browser regression preserves the rows, disables mutations,
  and verifies recovery remains available without leaving Summary.
- A successful-read TTL does not bound failures. PR observation owns a bounded
  attempt interval and stays independent of Git refresh generations and
  workspace object churn. Terminal PRs stop recurring reads, while activation
  and explicit refresh remain available. Unit and browser regressions cover
  failed-read bursts, retained values, explicit retry and terminal suppression.
