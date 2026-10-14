# Canonical temporary paths for macOS verification

The zstack receipt/source suites failed on macOS with `zstack_receipt_unsafe`
and `zstack_source_unsafe` because the default temporary directory used the
`/var` alias while the helpers require its canonical path. The unchanged suites
passed all 25 tests with `TMPDIR=/private/tmp`. For these filesystem-safety tests,
use a canonical temporary-directory path before attributing failures to a merge;
do not relax the production canonical-path checks. This belongs in
`zstack-verify` when fragments are folded.
