# Agent runtime pin parity

- Symptom: Local ran Cursor SDK 1.1.0 while the cloud worker stayed on 1.0.40
  after #749. The owner's rule is that every agent runtime (Codex, Claude,
  Cursor, including the CLIs they carry) is pinned identically for Local and
  the cloud worker. Cause: the runtime updater bumps only the root manifest,
  and no check compared the two manifests or the worker's own runtime
  constants (`VERSIONS` in `apps/cloud-worker/src/agents.ts`, the Cursor
  host's `CURSOR_VERSION`, which made the host refuse to start until updated).
  Rule: a provider runtime PR moves both manifests, the worker constants, the
  lockfile and the license bundle together, and integrates both the desktop
  adapter and the worker driver. Encoded in
  `scripts/__tests__/agent-runtime-pin-parity.test.ts`, `zstack-verify` and
  `docs/agent-runtime-notifications.md` ("Runtime pin parity").
