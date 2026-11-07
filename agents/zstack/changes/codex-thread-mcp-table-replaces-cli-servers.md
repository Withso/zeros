# A Codex thread's `mcp_servers` table replaces its `-c` servers

Target: `zstack-verify` provider checks, `zstack-review` checklist.

- Symptom: Codex chats never saw `zeros_computer`, `zeros_browser` or any
  other Zeros MCP tool. In a sandboxed shell, the first `zeros` command
  failed, GPT-6 searched its tools (none), then escalated: about 9 s lost per
  chat. Claude and Cursor were unaffected.
- Cause: Zeros passes its servers to `codex app-server` through `-c`, then
  disables native servers with a `thread/start` `mcp_servers` table. On Codex
  0.166 that table replaces the `-c` servers for the thread. Process-level
  `mcpServerStatus/list` still listed them, so it looked healthy.
- Rule: check provider config semantics against the pinned binary, and scope
  status reads to the thread (`mcpServerStatus/list` with `threadId`). Any
  thread-level server table restates every server Zeros registered, exactly
  as `-c` passed it.
- Follow-up: once visible, every Zeros MCP call raised a Codex approval card.
  Servers whose host decides (computer, browser, simulators, Local) register
  `defaultToolsApproval: "approve"`.
- Encoded: `app-server-adapter-native-mcp.test.ts` ("restates Zeros' own
  servers…"), the `zeros-*-tools.test.ts` registration assertions.
