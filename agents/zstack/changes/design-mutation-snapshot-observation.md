# Observe the mutation's snapshot read

The Design redo race test failed under CI load with one snapshot lookup instead
of two. Its polling helper allowed only one second for real filesystem and
history work, despite the suite's existing twenty-second test budget. A bounded
delay at the real mutation snapshot boundary reproduced the same assertion.

Wait for the exact-key lookup through an observed callback, keeping the original
test budget and old-versus-fresh snapshot/content assertions. Release and join
both requests before clearing the flight map or deleting the workspace, even
when an assertion fails. This is encoded in WorkspaceService's five mutation
cases. The `design-mutation-snapshot-freshness` seed removes the production
fresh-read guard to prove that the revised tests still reject stale replies;
it is not a replay of the test-only timing fix.
