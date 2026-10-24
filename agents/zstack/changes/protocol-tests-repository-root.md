# Run protocol tests from the repository root

- **Symptom.** A package-local Vitest invocation reported no tests for the
  edited cloud relay protocol suite.
- **Cause.** `packages/protocol` inherits the root Vitest config, whose include
  paths are relative to the repository root rather than that package directory.
- **Rule.** From the repository root, run
  `timeout 900 pnpm exec vitest run packages/protocol/src/__tests__/cloud-v2-relay.test.ts`
  or the required protocol directory. A no-tests result is unverified, never a
  passing protocol check.
- **Encoded in.** The existing `vitest.config.ts` includes and protocol suites;
  invocation guidance is in `skills/zstack-verify/SKILL.md`.
