# Runtime license inventory follows the release dependency

- Symptom: a runtime PR passed `check:licenses` but omitted the upgraded Claude
  macOS binary from its generated bundle.
- Cause: the workspace inventory contained both the desktop's new wrapper and
  the standalone cloud worker's old wrapper. Platform normalization selected the
  first matching name; generation and its freshness check agreed on that wrong
  parent. Installing a macOS optional binary cannot fix that selection.
- Rule: resolve platform parents from the owning release's installed direct
  dependencies, reject missing or ambiguous parents, and require the candidate's
  exact macOS package identity before runtime preparation can return a patch.
- Encoded in `scripts/__tests__/license-platforms.test.ts` (mixed Local/cloud
  versions and missing desktop parent) and
  `scripts/__tests__/agent-runtime-prepare.test.ts` (Claude, Codex alias and Cursor
  candidate identities). The generator still uses locked platform metadata and
  reviewed parent terms, so the release inventory is independent of host OS.
