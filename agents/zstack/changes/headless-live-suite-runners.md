# Headless live suites in a Conductor sandbox

Target: `gotchas.md` (environment) and `skills/zstack-verify` (live evidence).

- **Symptom.** A 30–60 minute live suite (Zeros Dev or Alpha: create, agents,
  PR flow, restore) lost steps silently. Steps were also marked done that had
  failed.
- **Cause.** A session restart kills every background job. The driver scripts
  caught their own errors and exited 0. `curl -s` treats a Cloudflare
  tunnel's HTTP 530 as success.
- **Rule.** Run a live suite as a resumable runner: one step per log file and
  a `.done` marker written only after a content check of that log (for
  example `PASSED` or an expected author line), never on exit status alone.
  Gate readiness with `curl -sf`. Run the Zeros Dev stack as its own
  background task, not inside the runner.
- **Env files.** `node:util` `parseEnv` treats an unquoted `#` as the start
  of a comment, so a `.env.agent` password containing `#` was cut short
  silently. Quote such values.
