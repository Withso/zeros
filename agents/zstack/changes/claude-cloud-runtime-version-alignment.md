# Keep the cloud runtime's declared, launched and advertised versions aligned

Symptom: the automated Claude upgrade changed the root SDK pin while the cloud
worker still packaged and advertised the previous version.

Cause: runtime automation owns the root pin; the standalone worker separately
pins its dependency, validates the native launcher version and publishes agent
metadata.

Rule: when an SDK upgrade includes cloud, update and verify all three version
contracts together. Reinstall the workspace graph before qualification, and
exercise the relocated runtime as well as the translators.

Encoded in `apps/cloud-worker/src/__tests__/claude-version.test.ts` and
`package.test.ts`: the first compares the launcher, installed SDK/native
packages and worker initialization/list replies; the second checks the target
runtime inventory and executes its bundled CLI outside the checkout. The
target-version package tests failed against 0.3.309 before the cloud bump.
