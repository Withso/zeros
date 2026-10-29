# Keep rule enforcement observable

The pack's rules had no map to their enforcing code, and merge preflight did not
require the engineering receipt. `enforcement.md` now maps each source rule to
named checks or judgment, with source fingerprints and an existence test. A
named test proves only its covered cases; the table states the remaining gap.

The PR-body gate parses Markdown headings rather than finding words in prose,
comments or code fences. Automation is identified by GitHub's author kind, never
by an editable title, label or agent trailer. Both merge paths recheck the author
with the PR snapshot. Existing incident and CI-definition refusals still apply.

Held by the agent-merge suites, zstack-enforcement.test.ts and the
seeded-pr-required-sections eval. Missing or misleading section contents still
need review; a heading check cannot prove them true.
