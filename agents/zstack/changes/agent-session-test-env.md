# Run engine suites outside the agent session's environment

Inside a Zeros agent chat, `config-isolation.test.ts` failed its ambient-unset
case because the chat's provider sets `CLAUDE_CONFIG_DIR`, and the cloud-native
HOME checks in `cloud-runtime-failures.test.ts` rejected the `/var` temp alias
(see `zstack-canonical-temp-paths`). Rerun with `env -i` (HOME, USER, SHELL,
LANG, a plain PATH) and `TMPDIR` set to the real temp path, both suites passed
except one Codex repository-settings case that also failed on a clean checkout
of the base commit. Before attributing such failures to a diff, rerun the files
that way, then on a clean checkout of the base commit. This belongs in
`zstack-verify` when fragments are folded.
