# `@zeros/protocol`

Transport-neutral contracts shared by the desktop renderer, local engine,
Electron boundary, and independently built process bundles. This package owns
wire messages, Zod schemas, protocol versioning, reliability helpers,
redaction, and encrypted-channel primitives.

The package must not import an application layer or platform API. Contract
changes require compatibility analysis, consumer updates, protocol tests, and a
version decision; cosmetic repository refactors must preserve exported names and
serialized values.

```bash
pnpm --filter @zeros/protocol typecheck
pnpm exec vitest run packages/protocol/src/__tests__ packages/protocol/src/crypto/__tests__
```
