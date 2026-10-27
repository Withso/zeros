# Runtime radar hosted App identity

The first enabled radar run opened the Codex and Cursor PRs, but `finalize`
failed and the PR report workflow failed after updating the tracking issue.
Three hosted behaviors differed from the fixtures:

1. GitHub signs commits an App creates through the API with the App as
   author and `web-flow` as committer. The radar expected a Bot committer.
   It could not confirm its own writes, left `lastBotCommit` null (so later
   advances became `baseline-unavailable`), and counted the bot's commit as
   human integration progress.
2. GITHUB_TOKEN posted issue state with `issues: write` but could not comment
   on the App PRs with `pull-requests: read`. Every job that runs `publish()`
   refreshes PR reports and failed.
3. Three parallel writers shared one App installation. Codex created about
   100 objects while the Claude writer failed before its first ref. The
   writer hides errors, so only the HTTP status could have shown why.

Rule: build radar fixtures from a real hosted response, not the intended
shape. A job that comments on a PR needs `pull-requests: write`. Serialize
App writers. Surface GitHub's numeric status, never a response body.

Encoded in `appCommit` (`scripts/agent-runtime/proposals.mjs`), the controller,
writer and workflow tests, the radar workflows, `docs/agent-runtime-notifications.md`
and case `runtime-radar-hosted-identity`.
