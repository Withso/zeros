An ESM unit test missed a startup failure when the workflow imported the same
module through tsx's CommonJS path. The runner never initialized or wrote a
receipt. The public Actions environment also printed a signed cleanup handoff
that was supplied as a variable instead of a secret.

Proposed ci-red rule: execute each changed workflow entry using its actual
interpreter and loader in a fresh no-network child, with no inherited secrets
or Git routing. Missing input must reach the entry's closed refusal. Audit
transitive top-level await separately from supported ESM-only entries. Values
that must be hidden before the runner logs its environment belong in Actions
secrets; masks emitted later by the process cannot repair an earlier leak.

The workflow-entry process tests, environment assertion and initialization mask
regression encode this rule. An artifact-less failure remains blocking except
for the exact owner-reviewed prestart incident, retained in signed successors;
the repair cannot convert it to skipped or green. Workflow/credential-policy
changes and the exact recovery record require the owner's merge.
