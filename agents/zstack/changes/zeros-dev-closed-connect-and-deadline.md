# Preserve the closed connection cause and native deadline

Symptom: a failed runtime admission lost its HTTP status and phase; a resume
deadline returned internal and omitted the observed setup attempt.

Cause: connect flattened every shared-client error after disposing its rejection
state, while the HTTP preflight threw native TimeoutError outside the closed
error boundary after token acquisition. Hourly results also discarded diagnostic
fields when preserving the first error code.

Rule for the bug-fix playbook: capture the first closed phase/class before
retirement, then test its path through the public result and signed receipt.
Expire deadlines before dispatch as well as during I/O, including between token
acquisition and the request. Unknown detail stays unknown; do not guess a
provider cause or introduce retries to hide a connection gap.

Encoded in the real shared-client loopback, synthetic HTTP/queued-setup deadline,
CLI and signed Actions tests; evals `zeros-dev-connect-inner-cause` and
`zeros-dev-native-wait-deadline`. This fragment carries the playbook lesson for
the next pack fold rather than editing the shared step-3 anchor concurrently.
