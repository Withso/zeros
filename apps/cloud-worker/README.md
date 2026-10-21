# Zeros cloud worker

A standalone worker for an organization's cloud workspace VM.
The VM is the trust boundary; native agents run in its real checkout.
The worker never imports the Local engine runtime.
The relay carries existing bridge frames; app disconnects leave work running.

Chat snapshots coalesce streamed rows at 250 ms and flush at turn end.
Codex is pinned to `@openai/codex` 0.162.1.
Full relay config replaces provider logins; active turns keep their spawn token.
Credentials are kept out of arguments, logs and session files.
Tests use synthetic native streams and local processes without model access.

Run `pnpm --dir apps/cloud-worker test` for the adjacent tests.
Run `pnpm --dir apps/cloud-worker typecheck` for the package typecheck.
