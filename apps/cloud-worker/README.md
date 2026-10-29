# Zeros cloud worker

A standalone worker for an organization's cloud workspace VM.
The VM is the trust boundary; native agents run in its real checkout.
The worker never imports the Local engine runtime.
The relay carries existing bridge frames; app disconnects leave work running.

Chat snapshots coalesce streamed rows at 250 ms and flush at turn end.
Pinned providers: Codex 0.165.0, Claude Agent SDK 0.3.311 and Cursor SDK 1.0.40.
Codex's voice runtime ships with its package; excluding it is deferred. The
patched zsh runtime was removed upstream in 0.163.0 and is no longer bundled.
Full relay config replaces provider logins; active turns keep their spawn token.
Credentials are kept out of arguments, logs and session files.
Tests use synthetic native streams and local processes without model access.

Codex effort and Fast changes update the exact active turn when native support
allows it, and persist for later turns and reopening. Model changes apply to
the next turn. The shared renderer catalog includes GPT-6.1 Terra in both
placements; the worker's model proxy supplies account availability.

Run `pnpm --dir apps/cloud-worker test` for the adjacent tests.
Run `pnpm --dir apps/cloud-worker typecheck` for the package typecheck.
