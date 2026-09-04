// ──────────────────────────────────────────────────────────
// System-instruction TEMPLATES — the ONE home for hardcoded agent text
// ──────────────────────────────────────────────────────────
//
// EVERY hardcoded string Zeros injects into an agent's prompt lives in THIS
// file. To change what Zeros tells the agents — the workspace preamble, the
// "/add-dir" awareness line, or any future per-action instruction — edit the
// constants here. Nothing else in the codebase should hardcode agent-facing
// instruction prose; the assemblers in ./build.ts fill these templates and
// ./index.ts re-exports them.
//
// Each template is tagged with a stable `[SYS-INSTR: <id>]` marker so you can
// grep the codebase for where it's USED (build.ts / the send path).
//
// Delivery model — two mechanisms, chosen per agent by the gateway:
//   • Mechanism "A" (in-band — Cursor and adapters without a native channel): wrapped in
//     <system_instruction>…</system_instruction> and PREPENDED to a user
//     message's agent-facing text. Used for agents whose protocol gives us no
//     separate system channel; the bubble the user sees stays clean.
//     FIRST-TURN preamble: injected ONCE, on the first user message of a chat
//     (it then rides along in the conversation history; not re-sent per turn).
//   • Mechanism "B" (native channel — adapters declaring
//     `nativeSystemInstruction`, today Codex and Claude): the SAME assembled body, sent
//     UNWRAPPED on the protocol's instruction field
//     (thread/start|resume.developerInstructions) instead of the first user
//     turn — it survives compaction and never masquerades as user speech.
//   • CONDITIONAL notices (e.g. /add-dir): always mechanism A, injected on the
//     specific message where the condition applies.
//
// Placeholders use {UPPER_SNAKE} and are substituted in ./build.ts.
// ──────────────────────────────────────────────────────────

/** [SYS-INSTR: workspace-preamble]
 *  The base, agent-agnostic workspace orientation. Prepended once on the first
 *  user message of every new chat (Claude / Codex / Cursor alike). Deliberately
 *  minimal: it states only what the agent cannot infer on its own — which
 *  directory to work in, which branch to diff and PR against, and that the
 *  branch is not its to rename. Everything else (project conventions, custom
 *  instructions) arrives through the assemblers in ./build.ts, so this text
 *  stays true for every repo.
 *  Substitutions: {WORKSPACE_DIR}, {TARGET_BRANCH}. */
export const WORKSPACE_PREAMBLE = `You are working inside Zeros, a Mac app for running coding agents in parallel.
Your work should take place in the {WORKSPACE_DIR} directory (unless otherwise directed).
The target branch for this workspace is {TARGET_BRANCH}. Use it for comparisons such as \`git diff {TARGET_BRANCH}...\` and as the base when creating a pull request.
Do not rename the current branch unless the user explicitly tells you to do so.`;

/** [SYS-INSTR: additional-dirs-notice]
 *  Awareness line for `/add-dir`. The agent is GRANTED filesystem access to
 *  these dirs (Claude SDK additionalDirectories) but is never told they exist —
 *  this line makes it aware so it proactively reads them. Used both inside the
 *  first-turn preamble (when dirs already exist) and as a standalone per-message
 *  notice when the user adds a dir mid-chat. Substitution: {DIRS}. */
export const ADDITIONAL_DIRS_NOTICE = `You also have access to these additional directories (read from them with your tools as needed): {DIRS}.`;

/** [SYS-INSTR: code-agent-design-territory]
 * Behavioral contract for the native Code actor. Identified Design subtrees
 * are live and readable in the same worktree; Code execution itself remains
 * native and unrestricted. Substitution: {DESIGN_DIRS} (absolute paths). */
export const CODE_AGENT_DESIGN_TERRITORY_NOTICE = `You are a coding agent. The Design directories identified in this workspace are: {DESIGN_DIRS}. They are live, readable product context in this worktree, but they are read-only to you. You must never create, edit, append, truncate, replace, move, delete, stage, or commit anything in those directories through shell, patch, editor, filesystem, or generic Git tools—even if the user asks. Do not change permissions, ACLs, links, or provider policy to work around this boundary. This Code session has no Design mutation capability and cannot turn itself into a Design agent. When you create or edit a dev-server or file-watcher configuration, exclude the Design directories from its watched paths so Design edits do not trigger code-server reloads or restarts. Design changes require the Design surface or a future separately contained Design agent using the Design API. Continue normal Code work, builds, tests, Git operations, tools, hooks, plugins, and MCP use outside those directories.`;

/** [SYS-INSTR: design-agent-workspace]
 *  Orientation for a persistent Design-agent process. Mutation authority is
 *  stated separately and last so repository-authored prompts cannot widen it. */
export const DESIGN_AGENT_WORKSPACE_PREAMBLE = `You are a persistent Design agent working inside Zeros. Use {WORKSPACE_DIR} as read-only product context. Analyze the Code workspace and the active Design draft, but treat every filesystem path as read-only.`;

/** [SYS-INSTR: design-agent-authority]
 *  Engine-owned, last-word capability boundary for autonomous Design work.
 *  Substitution: {DESIGN_DIR}. */
export const DESIGN_AGENT_AUTHORITY_NOTICE = `You are a Design agent. The active Design directory is {DESIGN_DIR}. Code files, Design files, draft-store bytes, and Git metadata are read-only from your process. Use only the scoped Design MCP tools for durable Design changes, especially design_document_open to refresh and design_transaction_apply to validate and atomically apply semantic edits. You must not write through shell, patch, editor, filesystem, or generic Git commands, and you must not stage, commit, pull, merge, or push. A successful Design transaction updates the shared draft and remains uncommitted until the user explicitly performs a Git action. On a revision conflict, reopen the document, inspect the new revision, and construct a new semantic transaction; never overwrite or bypass the conflict. Never print, persist, or disclose the Design capability credential.`;

export const DESIGN_AGENT_CONTEXT_NOTICE = `These additional directories are read-only context for this Design run: {DIRS}. Read them when relevant, but never modify their contents or Git state.`;

/** The XML-ish wrapper tag for mechanism "A". Agents reliably read an
 *  angle-bracketed block like this as out-of-band orientation rather than as
 *  something the user typed. Kept here so the format is in one place. */
export const SYSTEM_INSTRUCTION_OPEN = "<system_instruction>";
export const SYSTEM_INSTRUCTION_CLOSE = "</system_instruction>";

// ── Future per-action prompts ──────────────────────────────
// The Settings → Repo → Actions tab exposes these, one editable prompt per
// action button. For now only `general` (→ the first-turn preamble's
// custom-instructions slot) is wired.
// When the Review / Create-PR / Fix-errors / Resolve-conflicts /
// Rename-branch buttons are built, their hardcoded scaffolding goes HERE,
// tagged `[SYS-INSTR: action-<name>]`, and is assembled in ./build.ts.
