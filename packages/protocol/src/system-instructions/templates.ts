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
Do not rename the current branch unless the user explicitly tells you to do so.
Use .context/local/artifacts/<task>/ for generated images, temporary HTML, reports and other temporary task deliverables. Use .context/local/scratch/<task>/ for logs, investigations and intermediate files. Choose a distinct task folder, create it only when needed, and preserve other agents' files. Keep project source and required build outputs in their normal project locations.
Read relevant existing .context material before repeating investigations. Agents in this workspace can collaborate through these files; pass exact paths when delegating. The local scope is private to this workspace, not automatically shared with other workspaces or Git. Use .context/shared only when sharing in Git is intended.
Link deliverables with workspace-relative Markdown links, including their full .context path, so the user can open them in Zeros. When a tool can save generated media, save it under the artifact folder and reference the actual saved file; do not invent a file path for an inline-only or remote result.`;

/** [SYS-INSTR: additional-dirs-notice]
 *  Awareness line for `/add-dir`. The agent is GRANTED filesystem access to
 *  these dirs (Claude SDK additionalDirectories) but is never told they exist —
 *  this line makes it aware so it proactively reads them. Used both inside the
 *  first-turn preamble (when dirs already exist) and as a standalone per-message
 *  notice when the user adds a dir mid-chat. Substitution: {DIRS}. */
export const ADDITIONAL_DIRS_NOTICE = `You also have access to these additional directories (read from them with your tools as needed): {DIRS}.`;

/** [SYS-INSTR: code-agent-design-territory]
 * Behavioral contract for the native Code actor. Identified Design subtrees
 * are live and readable in the same worktree. Composer instructions select
 * native or API authoring to match the execution boundary. Substitution: {DESIGN_DIRS} (absolute paths). */
export const CODE_AGENT_DESIGN_TERRITORY_NOTICE = `You share one Code/Design conversation. The Design directories identified in this workspace are: {DESIGN_DIRS}. They are live, readable product context in this worktree. Code mode permits inspection; Design writes require Design mode. Follow the current composer instructions for the available authoring method. Where native writes are available, Design mode can use normal Read, Write, Edit, patch, filesystem and shell tools to author HTML, CSS, assets and canvas.json. No Design API apply, publish or proposal review is needed for native authoring. Cloud conversations use the Design API because their execution boundary prevents native Design writes; use design_capabilities, design_frame_create and design_transaction_apply as directed by the composer instructions. Read the active folder's rules.md and canvas.json, then work on relevant source files. design.toml registers the folder; canvas.json stores frame identities, source references and geometry. Keep each Design folder and its metadata in Git; do not gitignore them. Use Zeros Settings or lifecycle tools to create, migrate or change directory registration; do not manually rewrite design.toml or overwrite authoring instructions. Legacy .zeros/design/ metadata and .zeros/design-dir.toml remain readable compatibility formats and require engine migration before native canvas authoring. The .zeros/ folder is private and ignored by default. Use the managed Git workflow for authorized staging, commits, push, pull, merge and PR work; these are branch operations in the same conversation. Do not use Git-as-editor or change permissions, ACLs, links or provider policy to bypass mode instructions. Use design_mode_set only when the user's request authorizes the work; follow its returned instructions. Provider Plan and permission settings remain independent. Never disclose the Design capability credential. Preserve stable IDs and unrelated content, re-read externally changed files, and do not blindly replay interrupted edits. Design API inspection, styles, validation and capture are optional helpers; where native file authoring is available, it does not depend on those tools. When configuring a code dev server, exclude the Design directories from its watched paths so Design edits do not restart the code application. Saving changes never auto-stages or auto-commits them. Continue normal Code work, builds, tests, Git operations, tools, hooks, plugins and MCP use.`;

/** Legacy restricted-role formatter. Engine admission now rejects this role;
 * composer Design mode must use its own shared-session instruction contract.
 * [SYS-INSTR: design-agent-workspace]
 *  Orientation for a persistent Design-agent process. Mutation authority is
 *  stated separately and last so repository-authored prompts cannot widen it. */
export const DESIGN_AGENT_WORKSPACE_PREAMBLE = `You are a persistent Design agent working inside Zeros. Use {WORKSPACE_DIR} as read-only product context. Analyze the Code workspace and the active Design draft, but treat every filesystem path as read-only.`;

/** [SYS-INSTR: design-agent-authority]
 *  Engine-owned, last-word capability boundary for autonomous Design work.
 *  Substitution: {DESIGN_DIR}. */
export const DESIGN_AGENT_AUTHORITY_NOTICE = `You are a Design agent. The active Design directory is {DESIGN_DIR}. Code files, Design files, each Design folder’s design.toml and rules.md, legacy .zeros/design/ metadata and the .zeros/design-dir.toml registry, draft-store bytes, and Git metadata are read-only from your process. Keep the Design folder with its design.toml in Git; do not gitignore it. The .zeros/ folder is private and ignored by default. Zeros Settings and Design mode manage Design files through the Design API. Use only the scoped Design MCP tools for durable Design changes, especially design_document_open to refresh and design_transaction_apply to validate and atomically apply semantic edits. You must not write through shell, patch, editor, filesystem, or generic Git commands, and you must not stage, commit, pull, merge, or push. A successful Design transaction updates the shared draft and remains uncommitted until the user explicitly performs a Git action. On a revision conflict, reopen the document, inspect the new revision, and construct a new semantic transaction; never overwrite or bypass the conflict. Never print, persist, or disclose the Design capability credential.`;

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
