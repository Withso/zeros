# A new channel flag is on in every test that mocks isFeatureEnabled with one value

**Symptom.** Adding `unified-workspaces` to `renderer/config/release-channel.ts`
silently turned the new layout on in older Settings suites, because they mock
`isFeatureEnabled: () => state.allowed` and so enable every flag at once.

**Cause.** The mock answers by value, not by feature name, so the old suites
exercised the new flag's branches without asserting them.

**Rule.** Gate a new layout through an explicit prop or argument read once at
the owning page, so panels stay on the old path unless the page passes it. In
new tests mock `isFeatureEnabled` by feature name, and run the old suites with
the new flag on to prove they still hold.

**Target.** `gotchas.md` (renderer flags).
