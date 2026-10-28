# Compare checkpoints by content, never by archive bytes or times

The worker rewrites `workspace.json` with identical content (temp file and
rename) on every boot, so an archive hash or an mtime comparison would never
find an idle workspace unchanged. The stop checkpoint's fingerprint hashes
names, kinds, permission bits, link targets and contents, the Git manifest with
tree IDs in place of the time-stamped index and worktree commits, and the
capture script itself; the base commit is checked by ancestry, not equality,
because every wake fetches `origin`. Encoded in the checkpoint reuse tests in
`apps/control-plane/src/cloud/checkpoint.test.ts` ("however files were
rewritten or the base moved on").
