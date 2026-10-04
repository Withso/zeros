`cloud-runtime/` is a byte-for-byte snapshot of B1's shared golden fixtures
from the branch and commit recorded in `b1-source.json`. Do not edit that copy.
The Python tests and synthetic archive builder prefer
`packages/protocol/src/__tests__/fixtures/cloud-runtime/` when B1 is merged.
This keeps B4 testable in isolation without editing files owned by B1.

The bootstrap consumes the descriptor, install, manifest, and installer
diagnostic cases. For changes only to JSON serialization, the bootstrap checks
the raw bytes against the admitted canonical manifest digest; it does not
re-serialize a manifest to establish identity.

`manifest.invalid-lexical-symlink-escape.json` is the additional R-282 negative
fixture: `alias -> aa/bb` and `zalias -> alias/../..` resolve within the tree but
the second target escapes lexically. It is also rejected by B1's manifest
schema and is available for B1 to add to its shared catalog. The test prefers
the shared version when present.
