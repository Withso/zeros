# MCP values and chat notices

- Symptom: Codex refused valid native Browser and registered MCP configuration
  during chat startup. Cause: strict equality compared TOML's null-prototype
  nested tables with ordinary JSON objects. Rule: compare complete wire values
  across serialization formats, and pair refusal tests with successful native
  responses containing environment and header maps. Keep extra or modified
  execution settings rejected. Encoded in `mcp-overrides.test.ts`,
  `app-server-adapter-native-mcp.test.ts` and the `codex-mcp-json-tables` eval.
- Symptom: optional setup and recoverable provider diagnostics used the same
  tinted banner as a failed chat. Cause: the shared notice renderer ignored
  severity, recoverability and child ownership. Rule: reserve banners for
  blocking startup or turn failures and explicit recovery actions; render
  nonblocking notices as plain status for every provider and placement. A native
  explicit-review gate can pause a recoverable turn; retain its action banner.
  Encoded in `agent-notice.test.ts`, `ui-smoke-agent-notices.mjs` and
  `docs/agent-tool-presentation.md`.
