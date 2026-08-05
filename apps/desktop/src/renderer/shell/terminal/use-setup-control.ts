// ──────────────────────────────────────────────────────────
// Setup sub-tab id
// ──────────────────────────────────────────────────────────
//
// HISTORY: this module used to own `useSetupControl` — the trunk / "main"
// fallback that ran `scripts.setup` in an inline plain terminal
// (`pty-setup-<hash>`), because the synthetic `local:<repoSlug>` workspace has
// no engine workspace row. The engine's SetupManager now accepts an explicit
// rowless target (see apps/desktop/src/engine/git/setup-runner.ts), so the trunk runs
// through the SAME engine-backed, state-tracked Setup view as a worktree and
// the inline-terminal path is gone. TerminalPanel purges any persisted legacy
// `pty-setup-*` session on mount.

/** The fixed terminal panel tab id for the Setup view (a run tab uses the run
 *  session's deterministic id; everything else is a plain session id). Lives
 *  here (not terminal-tab.tsx) so workbench's create-time initialization can share it
 *  without a circular import. */
export const SETUP_SUBTAB = "setup";
