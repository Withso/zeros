# Zeros cloud worker

A standalone worker for an organization's cloud workspace VM.
The VM is the trust boundary; native agents run in its real checkout.
The worker never imports the Local engine runtime.
The existing protocol owns the messages consumed by the shared UI.

Chat snapshots coalesce streamed rows at 250 ms and flush at turn end.
Codex is pinned to `@openai/codex` 0.162.1.
Proxy configuration accepts a base URL and a short-lived workspace token.
Credentials are kept out of arguments, logs and session files.
Tests use synthetic native streams and local processes without model access.

Run `pnpm --dir apps/cloud-worker test` for the adjacent tests.
Run `pnpm --dir apps/cloud-worker typecheck` for the package typecheck.
