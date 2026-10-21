The required PR secret scan failed on a New pages capture. gitleaks read a
captured diff hunk's `data-hunk-review-key` content hash as a
`generic-api-key`. Local `pnpm check:secrets` had passed: it scans the tree
for this repository's credential patterns, not the PR's commit range with
gitleaks rules. A follow-up commit that removed the attribute still failed,
because the scan reads every commit in the range.

Rule: captured DOM keeps only what paints. Drop runtime identities such as
content hashes, review keys and generated ids before writing a frame. When
the PR secret scan flags a commit, rewrite the branch so no commit in the
range carries the value (squash, then push with `--force-with-lease`)
instead of adding a fix commit. The capture rig's attribute drop list now
includes `data-hunk-review-key`.
