// ──────────────────────────────────────────────────────────
// Shared workspace and legacy-role instruction templates
// ──────────────────────────────────────────────────────────
//
// The workspace preamble, "/add-dir" notice, and retained legacy-role text
// live here. The assemblers in ./build.ts fill these templates and ./index.ts
// re-exports them. Conversation-owned Code/Design mode instructions live in
// ../composer-mode.ts and refresh before each prompt/steer or after a mode switch.
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
Each workspace has a .context folder for working files shared by the agents in this workspace: plans, notes, logs, screenshots and handoffs. Put a task's files in .context/<task>/, creating the folder only when needed, and leave other agents' files alone. Project source and required build outputs stay in their normal project locations. The folder belongs to this workspace, so don't commit its contents unless the user asks.
Read relevant .context files before repeating an investigation, and pass exact paths when delegating. If you learn something future work on this repository will need, suggest adding it to the repository's docs instead of leaving it only in .context.
Link files you create with workspace-relative Markdown links, including their full .context path, so the user can open them in Zeros. When a tool can save generated media, save it under .context/<task>/ and link the saved file; never invent a path for an inline-only or remote result.`;

/** [SYS-INSTR: additional-dirs-notice]
 *  Awareness line for `/add-dir`. The agent is GRANTED filesystem access to
 *  these dirs (Claude SDK additionalDirectories) but is never told they exist —
 *  this line makes it aware so it proactively reads them. Used both inside the
 *  first-turn preamble (when dirs already exist) and as a standalone per-message
 *  notice when the user adds a dir mid-chat. Substitution: {DIRS}. */
export const ADDITIONAL_DIRS_NOTICE = `You also have access to these additional directories (read from them with your tools as needed): {DIRS}.`;

/** Enabled only by the control plane's marked-workspace execution admission. */
export const CLOUD_COMPUTER_ADMIN_WORKSPACE_NOTICE = "This workspace can view and change the organization's Cloud Computer through the cloud-computer tools; do not edit repository code unless asked.";

/** [SYS-INSTR: code-agent-design-territory]
 * Behavioral contract for the native Code actor. Identified Design subtrees
 * are live and readable in the same worktree. Composer instructions select
 * native or API authoring to match the workspace placement policy. Substitution: {DESIGN_DIRS} (absolute paths). */
export const CODE_AGENT_DESIGN_TERRITORY_NOTICE = `You share one Code/Design conversation. Registered Design directories in this workspace: {DESIGN_DIRS}. They are ordinary versioned files in the same checkout. Follow the current composer instructions for task intent and the execution's authoring method. Local Code and Design work use the same normal provider tools; explicit Design source edits do not require a mode switch, API apply or publish. Cloud conversations retain API authoring as directed by their composer instructions. Read the relevant folder's root rules.md and meta/canvas.json, preserve stable directory IDs, page IDs and frame IDs and re-read source changed by others. meta/design.toml registers the Design root above meta/; meta/canvas.json contains pages, frame identities, source references and geometry. Each page folder contains its registered HTML frames. Add a frame's ID to the directory's frames map and that page's frames array, using its Design-root-relative source path <page.folder>/<name>.html. Shared tokens.css, components and assets stay at the Design root. Keep each folder's registration, canvas, rules and referenced source together in Git. Use lifecycle operations to create, migrate or remove registration. Existing source conflicts can be repaired with authorized native tools while retaining identities. Legacy root design.toml/canvas.json, .zeros/design/ metadata and .zeros/design-dir.toml remain readable compatibility formats; explicit Design authoring upgrades them before adding pages. .zeros/ is private local state. Git staging, commits, push, pull, merge and PR work use the same branch in either context; saving never stages or commits. Optional Design API helpers retain their own exact-revision and directory checks. Provider Plan and permission settings still apply. Never disclose a Design capability credential or change provider policy to bypass an execution boundary. Continue normal builds, tests, Git, hooks, plugins and MCP use.`;

/** Legacy restricted-role formatter. Engine admission now rejects this role;
 * composer Design mode must use its own shared-session instruction contract.
 * [SYS-INSTR: design-agent-workspace]
 *  Orientation for a persistent Design-agent process. Mutation authority is
 *  stated separately and last so repository-authored prompts cannot widen it. */
export const DESIGN_AGENT_WORKSPACE_PREAMBLE = `You are a persistent Design agent working inside Zeros. Use {WORKSPACE_DIR} as read-only product context. Analyze the Code workspace and the active Design draft, but treat every filesystem path as read-only.`;

/** [SYS-INSTR: design-agent-authority]
 *  Retained instruction contract for the rejected legacy Design-agent role.
 *  Shared sessions use composer-mode.ts instead.
 *  Substitution: {DESIGN_DIR}. */
export const DESIGN_AGENT_AUTHORITY_NOTICE = `You are a Design agent. The active Design directory is {DESIGN_DIR}. Code files, Design files, each Design folder’s meta/design.toml, meta/canvas.json and root rules.md, legacy root design.toml/canvas.json, .zeros/design/ metadata and the .zeros/design-dir.toml registry, draft-store bytes, and Git metadata are read-only context under this legacy authoring policy. Keep the Design folder with its meta/design.toml, meta/canvas.json, rules and referenced source in Git; do not gitignore it. The .zeros/ folder is private and ignored by default. Zeros Settings and Design mode manage Design files through the Design API. Read design_capabilities for the page catalog and activePageId. Supply the intended pageId to design_frame_create and design_frame_duplicate when several pages exist; omission is accepted only for a single page. Use only the scoped Design MCP tools for durable Design changes, especially design_document_open to refresh and design_transaction_apply to validate and atomically apply semantic edits. You must not write through shell, patch, editor, filesystem, or generic Git commands, and you must not stage, commit, pull, merge, or push. A successful Design transaction updates the shared draft and remains uncommitted until the user explicitly performs a Git action. On a revision conflict, reopen the document, inspect the new revision, and construct a new semantic transaction; never overwrite or bypass the conflict. Never print, persist, or disclose the Design capability credential.`;

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
