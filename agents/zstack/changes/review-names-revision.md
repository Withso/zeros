# Name the revision a review covers

A branch audit reported three release blockers, including missing migrations
0209–0211. It had reviewed a standalone checkout's uncommitted snapshot while
the work was being integrated elsewhere; the pushed branch head already fixed
all three, with regression tests and a passing migration-sequence check. A
review now states the exact commit (or `git stash create` SHA) it covers and
confirms each blocker still exists at the branch head before reporting it.
Encoded in `zstack-review`.
