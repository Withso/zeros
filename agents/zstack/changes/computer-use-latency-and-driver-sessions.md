# Computer-use speed: time the driver hop before the model

Target: `gotchas.md` (macOS computer use), `zstack-drive`.

- Symptom: each `zeros computer` command took 3–6 s; turns barely beat the
  MCP path. Cause: cua-driver 0.34.1 `list_apps` scans every installed app
  (0.8–1.8 s per call). The CLI resolved `--app` with it and the controller
  called it again inside `list_windows`, `open_app` and `open_url`: 11 scans,
  14.5 s of a 35 s turn. Rule: before optimizing, time each hop (driver
  `session.callTool`, controller `invoke`, engine `/call`, the CLI's `--json`
  `ms`) with temporary logs in the Mac checkout only. Encoded: one shared 30 s
  listing in `controller.ts` and its tests. After it every command costs its
  driver work plus about 60 ms.
- `press_key` (1.6–2 s) and `type_text` (1.4 s) wait on the driver's own
  accessibility read-back. 0.34.1 has no setting for it.
- Symptom: on the base build, every second computer-use chat failed with
  "session is not available to this transport". Cause: the driver never
  re-issues a closed session's public label, and Zeros reused the agent's name.
  Encoded: a fresh label per session (`driver.ts` and its tests).
- Harness: Conductor `RunLocalCommand` stops a command after 60 s, so detach
  runs with `nohup` and poll. Start input only after `HIDIdleTime` shows the
  user idle. Killing the dev launcher can reopen the app on Settings; main's
  hot restart keeps the route. Pin one `settings.toml` for both builds, such as
  `navigation_approval`, and say so in the result.
