Checks selected from prose and nonzero test exits can produce false confidence.
Z1 reuses the CI registry, executes only known argv recipes, binds receipts to
source fingerprints, and separates local evidence from CI and native proof.

Historical dependency links must point into the projected source. A shared
root `node_modules` symlink can accidentally test the current workspace package.
The projection test enforces workspace-package rebinding and exact lockfiles.

Review found that a missing tool thrown inside a test could look like a caught
assertion, duplicate eval IDs could inflate results, and a writable output
directory could replace receipt entries. Retained red-first tests now require
closed infrastructure classification, immutable unique comparison inputs and
an owned descriptor-validated receipt directory. The replay/verify skills and
`tools.md` document limits; the two isolated seeds cover the renderer generation
guard and cloud writer provenance without editing product source.

The first real 20-case replay exposed the opposite classifier error: the
credential-lock race's product ENOENT was suppressed as infrastructure. Limit
classification to explicit primary prerequisites, never arbitrary error-code
substrings or quoted assertions. Repeated parameterized test names also need
occurrence identities; otherwise a passed sibling can hide a skipped green
assertion. Concrete reporter-through-runner regressions retain both failures,
and the corpus is rerun with its original immutable inputs and denominator.

The final argument review also found that a test-name value could be another
option, such as `--watch`. Reject option-shaped values before spawning; fixed
argv still needs value validation. Two retained parser regressions enforce it.
