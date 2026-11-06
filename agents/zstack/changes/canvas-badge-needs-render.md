# Take a Planned badge off only beside a render of the page

**Symptom.** The first Web app round took the Planned badge off the cloud
workspace loading and GitHub checking frames after checking their copy. Both
frames draw a 16px loader that neither page had. The second round drew the
dashboard's loader as a round ring, while the app's Orbit and the canvas draw
a square one. The same round removed four rows from the route map without
shrinking its board, which left 212px of empty sheet.

**Cause.** Each frame's copy was checked (title, line, actions) instead of
putting a render of the page beside the frame. The dashboard's loader was a
recipe written from memory, not copied from the app's source. Board heights
were measured once and never again.

**Rule.** Take a badge off only after a render of the shipped page sits beside
the frame and everything the frame draws matches: copy, actions, loaders and
icons. A component the web shares with the app copies the app's recipe from
its source; for the loader that is `shared/ui/loading/zeros-spinner.tsx`.
After removing frames or rows, re-measure the board with the canvas fonts
loaded, then refit its height and the row label's width.

**Encoded in.** `apps/web/lib/page.test.mjs`, which pins one Orbit for the
shell and the dashboard, and the workspace and GitHub page tests, which pin
where the loader shows; `agents/zstack/playbooks/ui-design.md` step 8; eval
case `canvas-badge-needs-render`, fixed by commit 37b89617.
