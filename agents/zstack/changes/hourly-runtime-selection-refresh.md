# Hourly fixture follows the qualified runtime

Symptom: the canary's durable Computer became stale after a runtime publication,
so an otherwise usable fixture would close the hourly merge gate.

Cause: the check compared a saved pin with a moving qualified default but had no
bounded refresh path. Source revisions produce new runtime IDs even when their
runtime behavior is unchanged.

Rule: observe and capture the qualified tuple once; rebuild only on mismatch,
at most once, with a separate deadline. Recheck the intended pin before allocation
and before declaring success. Distinguish unavailable qualification and changed
selection from product failures, and preserve the first error and signed intent.

Encoded in the bug-fix playbook, the hourly/product/Actions regressions and eval
`hourly-runtime-selection-refresh`. Runtime content addressing remains a separate
design item; this fix does not change archive or qualification identity.
