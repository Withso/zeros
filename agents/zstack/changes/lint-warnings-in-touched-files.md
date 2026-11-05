# Lint passes with new warnings

Target: `skills/zstack-verify` (static gates).

- **Symptom.** A React hook dependency warning from an MCP editor commit
  reached the branch although `pnpm lint` had passed.
- **Cause.** `pnpm lint` exits 0 on warnings, and the repository already
  carries a known warning, so a new one blends in.
- **Rule.** Read the warning list of `pnpm lint`, not only its exit code. A
  warning in a file the change touched is new work unless the merge base has
  it. Fix it at its cause (for example, list a stable `useMemo` value as a
  dependency), never with a disable comment.
- **Encoded in.** Guidance only. Failing on new warnings needs the existing
  warning resolved first.
