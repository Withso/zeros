Symptom: the CP's new typed transient 503 was reduced to request_failed by the
desktop client, leaving the canary without safe retry advice or retained costs.

Cause: the existing native error allowlist intentionally dropped unknown codes
and response fields; implementing a later CLI string match would miss that
boundary and risk authorizing retries from untrusted provider text.

Encoded by: concrete client/parser and broker-fence tests in
`cloud-workspace-admission-retry.test.ts`, signed-device loopback and hourly
receipt regressions, and eval `typed-admission-retry-boundary`.

Proposed target: playbooks/bug-fix.md, transport boundary guidance at the next
pack-owner fold. Proposed text: Trace a retry contract through every parser.
Authorize only its exact closed envelope and bounded delay, with fresh proof
and the original lifetime and owner fences. Record the first failure and each
executed retry even when the operation later succeeds; an oversized delay
ends the attempt instead of resetting or clamping its budget.

Review precision: emit retry evidence only after handing the request to the
transport. A diagnostic callback may synchronously abort or consume the last
budget; deterministic regressions retain the actual dispatch count and late
grant retirement in both cases.
