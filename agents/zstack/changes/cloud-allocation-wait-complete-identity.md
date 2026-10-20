# Exact allocation waits require complete original resource identity

A wait accepted a null provider binding, so normal compute settlement filled
the binding and the immutable comparison superseded the accepted wake. A missing
allocation-result resource has the same problem. An otherwise valid first
binding is not evidence that the original attempt had complete identity.

Keep either incomplete original resource identity on ordinary retry before
scope comparison, including settlement between allocator refusal and wait
publication. Do not adopt later identity or relax immutable equality.

Encoded in `allocation-waits.ts`, real PostgreSQL controls in
`allocation-waits.integration.test.ts`, the `cloud-exact-allocation-wait` eval
and the bug-fix playbook. The tests retain the independently reported case,
bound and flag-off controls, nullable authorized allocation results and the
actual independent settlement on both sides of publication.
