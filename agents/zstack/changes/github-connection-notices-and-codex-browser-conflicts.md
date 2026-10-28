# GitHub connection notices and Codex Browser conflicts

- Symptom: once Local GitHub was signed out, every File, Changes and Review tab
  of a workspace with a pull request showed "Couldn't load this file",
  "Couldn't load changes" or "Couldn't load the review", even images and PDFs
  whose content loaded. Cause: the optional pull request comment overlay
  published its `NOT_AUTHENTICATED` read as the hosting tab's failure. #747's
  grant generations made every pre-existing GitHub App refresh binding
  reconnect-only, so the sign-out followed the next 8-hour token expiry.
  Rule: a refused GitHub connection is guidance, not a failed read; publish it
  as a neutral notice that names Settings → Integrations, and keep genuine
  read failures as errors. Encoded in `github-review-activity.test.ts` and the
  `github-connection-not-tab-failure` eval.
- Symptom: Codex chats with Browser enabled failed to open with "MCP
  configuration conflict for node_repl" after ChatGPT Desktop wrote its own
  `[mcp_servers.node_repl]` to `~/.codex/config.toml`. Cause: Codex merges
  Zeros' verified override into that table, and the complete-definition check
  correctly refuses the hybrid; Import cannot help because Zeros always
  replaces an imported `node_repl` with its verified runtime. Rule: when the
  only conflict is Zeros' own Browser registration, retire it once, restart
  without the built-in browser (Zeros browser fallback when admitted), disable
  the native declaration for that thread and send a capability notice. Every
  other conflict still blocks. A retired runtime's late exit must not reach the
  session that replaced it. Encoded in `app-server-adapter-binding.test.ts`,
  `agent-capability-notice-toast.test.ts` and the
  `codex-browser-native-node-repl-conflict` eval.
