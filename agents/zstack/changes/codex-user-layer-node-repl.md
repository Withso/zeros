# Codex user-layer node_repl and Alpha release reruns

- Symptom: after #762, every user whose ChatGPT Desktop writes
  `[mcp_servers.node_repl]` to `~/.codex/config.toml` lost Codex's built-in
  browser in Zeros: the complete-definition check correctly refused the hybrid
  that Codex merges from that table and Zeros' override. Cause: the check had no
  provenance. A key from the user's own layer looked the same as one from a
  repository's `.codex/config.toml`. Rule: read `config/read` layers only on a
  conflict; accept extras only when the sole non-session layer declaring the
  server is `user`, every extra equals that layer's value, and each key is on an
  inert allowlist derived from the consuming code (instruction text, a bounded
  tool timeout, and `SKY_CUA_SERVICE_PATH` equal to the default the CUA client
  derives from CODEX_HOME). Replace list fields (`args`, `env_vars`)
  explicitly, because Codex replaces arrays and merges tables. Refuse every
  other layer and key. Test with the real app-server merge, not only fixtures,
  and keep the rule independent of one user's paths or settings. Encoded in
  `mcp-overrides.test.ts`, `app-server-adapter-binding.test.ts`,
  `browser-tools.test.ts` and the `codex-user-layer-node-repl` eval.
- Symptom: rerunning a failed Release (alpha) with `--failed` passed hosted
  services but failed "Publish Alpha feed". Cause: publication requires the
  signed build from the same run attempt. Rule: rerun failed releases in full
  and confirm `/v1/release-identity` and the `alpha` release afterwards.
  Encoded in `playbooks/alpha-operator.md`.
