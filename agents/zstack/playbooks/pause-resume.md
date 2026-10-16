# Playbook: pause and resume a multi-agent effort

Only the user decides to pause, usually because model usage limits are low.

## Pause

1. Let any running operator command finish. Never leave a half-applied live
   action.
2. Each agent freezes its work in its scratch folder and posts one line: its
   worktree, base SHA, patch path and SHA, last green check, and the exact next
   command or step.
3. The master copies those lines and its own state (open PRs, release status,
   pending live work and deadlines) into the plan's resume section.
4. Stop monitors.

## Resume

1. Read only the plan's resume section.
2. Check what changed while paused: new `main` commits, release runs, CI
   incidents.
3. Send each agent its recorded next step, refreshed for any base that moved.
4. Re-arm monitors.
