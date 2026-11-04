# Previous cloud decoders

`previous-cloud-decoders.mjs` is a tree-shaken build of the actual desktop and
protocol source at `b3f7105390ff9339f55a245646a2bcff51e0f49d`, origin/main before
cloud failure metadata. The provenance JSON records the retained source files,
their SHA-256 hashes and the artifact hash. It contains Zeros code (MIT); Zod is
an external dependency, using the same pinned version as that revision.

Regenerate from the repository root, with that commit available locally:

```
node apps/desktop/src/renderer/platform/bridge/__tests__/fixtures/generate-previous-cloud-decoders.mjs
```

The generator reads Git objects, marks unrelated modules free of side effects
for tree shaking, and keeps the exported decoders and their reachable helpers
unchanged. Tests load the frozen artifact without Git, network access or a deep
checkout. Do not replace it with an approximation of the older schemas.

The compatibility test covers strict relay/history/outbox envelopes, the real
WebSocket parser, cloud identity mapping, the live reducer, and the persisted
history parser. Metadata lives inside opaque bridge payloads and serialized
history rows. The strict HTTPS outbox outcome/status envelopes stay unchanged;
their delivery state does not assert a provider failure reason.
