# Headless SDK conformance needs the real entry point

Symptom: an SDK adapter passed Vitest but failed a plain Node/tsx harness import
because a transitive renderer configuration read `import.meta.env`.

Cause: native IPC bindings were imported by the transport module. Vitest's Vite
environment masked a dependency unavailable to the headless consumer.

Rule: when reusing desktop transport code in an operator harness, inject native
authority at composition and retain a cold import of the actual Node entry
point. Validate the real SDK/native protocol path; an older admission's timing
or a skipped flag probe cannot establish new transport coverage. Recheck the
file-backed device after asynchronous authority reads before publishing success.

Encoded in `scripts/__tests__/zeros-dev-sdk-canary.test.ts` (plain Node entry,
cryptographic fixture, discovery and identity races),
`scripts/__tests__/zeros-dev-sdk-evidence.test.ts` (closed coverage/skips), and
`scripts/__tests__/zeros-dev-infrastructure.test.ts` (all connection points and
detached isolation). This is a new harness path, with no live pass claimed.
