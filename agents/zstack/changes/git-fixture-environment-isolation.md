# Isolate Git fixture commands from inherited repository routing

A verification runner for a source-only tree exported Git directory and worktree
overrides. Temporary fixture commands inherited them: changing `cwd` did not
prevent Git from using the shared checkout's metadata. The master restored that
metadata; no source change or push was required.

The runner now removes all seven Git routing variables before checks. The
control-plane scope fixture helper and its spawned scope checks independently
remove the same overrides. A retained regression points every override at a
fresh disposable sentinel repository, creates and commits in another fixture,
checks its own scope output, and verifies the sentinel's metadata is unchanged.
Its red failed to create an independent fixture; the corrected helper keeps
both repositories separate. No test uses the shared checkout as a sentinel.

This is a scenario eval because it hardens the verification harness itself;
overlaying only product files would not replay the old fixture helper. The
CI-red playbook records the environment rule and the separate eval names the
exact regression. Shared Git metadata remains under the master's ownership.
