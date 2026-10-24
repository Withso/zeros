Reset removed the visible transcript while the chat's persisted native provider
binding still resumed discarded history. Clearing only the binding also left
late provider events, in-flight loads and cached renderer history able to revive
that context.

A conversation reset must retire the exact chat's execution and commit its
transcript cut with a durable fresh-context generation. Rebuild context from
canonical retained history, fence late results and stale identity writes, and
repeat that boundary when Undo restores history. Keep the renderer replay
fallback until the engine advertises that it owns replay.

The engine reset suite covers Claude, Codex, Cursor, restart, interruption,
Undo and late work. Renderer hydration and replay-routing suites cover exact
chat invalidation and mixed engine versions. The service regression deliberately
uses only pre-existing imports so the eval can run the same assertions on the
pre-fix tree. The bug-fix playbook records the lifecycle rule.

Review also caught unconditional removal of a legacy renderer's replay when
the execution had no chat id. Canonical replay requires a chat owner; retain
the supplied context on the supported chatless load path. The engine suite
loads and prompts each provider without a chat id to cover this compatibility
boundary alongside the stale-replay replacement test for a reset chat.
