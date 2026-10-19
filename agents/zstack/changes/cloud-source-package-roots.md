# Package from runtime roots, preserve late consumers

Symptom: the cloud runtime shipped desktop renderer packages and source tests
because its closure started with every production dependency in the shared root.

Cause: a production install describes dependency class, not deployment reachability.
Static imports alone also miss command paths, native payloads and source probes.

Rule: discover the complete retained runtime/qualification source graph, add
explicit late native/CLI/LSP roots, and retain each selected package's declared
closure and data. Keep source-mode qualification and exercise the relocated tree.

Encoded in cloud runtime source-closure and dependency-closure tests, including
standalone child entries, late package data, notices and renderer exclusion.
