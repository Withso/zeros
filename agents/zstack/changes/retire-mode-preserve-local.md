# Retire a dead mode without losing the Local work layered on it

The owner asked whether restoring "pre-cloud" Local code would erase Local
features built during the cloud era. Reverting to old files would have. The
v1 cloud removal instead folded each dead check to its Local branch:
`gitExecutionIdentity()` became `undefined`, `isLocalGithubRead()` became
`true`, `cloudModeAdmission(fn)` became `fn()`. It then deleted only the
statements that touched the retired members. Pass-through wrappers are
inlined, not folded to null.

Before each commit, blame every removed line at the parent and group the lines
by the commit that wrote them. Read every group that came from a non-cloud
pull request, such as #583's read coalescing or #175's Design capture. Confirm
that the Local branch of each condition survives, and that only the
cloud-placement test cases go.

This belongs in `playbooks/bug-fix.md` (refactor/removal) and `zstack-review`
when fragments are folded.
