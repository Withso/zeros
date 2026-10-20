# Cursor resume must distinguish connectivity from account settings

A saved registry model failed to resume on a slow connection even though the
same conversation later loaded successfully. Both startup paths already awaited
discovery; its five-second timeout erased the distinction between no answer and
a successful answer without the required model schema.

Wait within a bounded catalog budget, retry a transient transport failure once
inside that original budget, and preserve the native conversation and exact
selection. Report connection progress and exhaustion separately from confirmed
account/model refusal. Authentication, throttling, malformed catalogs and changed
authority remain terminal. Ignore late completions and retire rejected session
hosts. Local discovery must not acquire a control-plane dependency.

Encoded in the Cursor registry discovery regressions, dedicated-host cleanup
controls, the actual Local gateway test, the discovery deadline seed, and
`docs/agent-tool-presentation.md`.
