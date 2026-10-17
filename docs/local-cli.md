# Zeros Local CLI

`zeros local …` lets an agent in a Local chat coordinate other agents: open
chat tabs and workspaces with any picker agent and model, send them work, read
their transcripts, steer and stop them, follow them, and answer their question
and permission cards. Every chat it starts is an ordinary chat tab the user can
open, read and stop. This guide owns the engine side: who gets the CLI, what a
chat can see, how new chats inherit settings, how work is delivered, the
persisted records, links and the staged rollout.

Cloud workspaces and organization-owned workspaces do not get it; they will
get a separate CLI/API later.

Related guides:

- [Agent control](agent-control.md) owns the staged-rollout table this feature
  joins (`localOrchestration`, stage `internal`).
- [Agent identity model](agent-identity-model.md) owns conversations,
  executions and provider bindings, which the CLI reuses unchanged.
- [Tool presentation](agent-tool-presentation.md) owns steering, Stop and cards
  in the transcript.

## Who gets it

`local-orchestration/admission.ts` is a session-tool owner beside Design and
agent control (`composeAgentSessionToolFactories` in `zeros-engine.ts`). For
each provider execution it admits tools only when all of these hold:

- the engine is not a cloud worker and `localOrchestration` is open;
- the execution belongs to a chat, and the chat's folder resolves to a Local
  owner (`owners.ts`): the most specific managed workspace with a null
  `organization_id` and `local` placement, or, with no managed workspace, the
  most specific registered repository root (a main checkout or a plain
  folder), addressed as `folder:<projectId>`. Organization or cloud rows and
  unregistered folders get nothing; a registry read failure fails closed.

An admitted execution gets:

| Name                           | Value                                                                    |
| ------------------------------ | ------------------------------------------------------------------------ |
| `ZEROS_LOCAL_URL`              | `http://127.0.0.1:<port>` of the engine-wide Local endpoint (`server.ts`) |
| `ZEROS_LOCAL_TOKEN`            | Execution-scoped bearer for the CLI; stored hashed, revoked on dispose    |
| `ZEROS_LOCAL_TOOLS_CAPABILITY` | `Bearer …` for the `zeros_local` MCP server                              |
| `ZEROS_LOCAL_WAIT_MS`          | Suggested CLI wait: Claude 90 s, Cursor 25 s, Codex 8 s                   |
| `ZEROS_LOCAL_CLI`              | Absolute path of the `zeros` launcher                                     |
| `ZEROS_LOCAL_SKILL`            | The bundled `zeros-local-cli` skill                                       |
| `ZEROS_LOCAL_DROPBOX`          | Private per-execution folder under the engine's `$TMPDIR` (`dropbox.ts`)  |

These names are compatibility contracts. The launcher directory goes first on
`PATH` (`AgentSessionTools.pathPrepend`). An engine strips all of them from its
own environment at start, so an engine launched from inside an agent chat never
passes the outer chat's access to its terminals or agents.

The endpoint takes one `POST /local/v1/call` with an exact loopback `Host`, no
`Origin`, the bearer and a JSON body of at most 1 MiB, and always answers a
`LocalEnvelope`. A call still running after 4 s commits `200` and sends a
space every 4 s until the envelope (JSON readers ignore leading whitespace),
so idle-connection limits never cut a wait or a slow workspace create.

The CLI is the packaged engine binary's lazy `local` branch
(`apps/desktop/src/cli.ts` → `local-orchestration/cli.ts`); it never boots the
engine, database or providers. Packaged builds ship
`Contents/Resources/bin/zeros` and `Contents/Resources/zeros-local-cli-skill`
(`electron-builder.yml`, guarded by `check:packaging-paths`); source builds
write a launcher under the data directory (`launcher.ts`).

The same commands are one MCP tool, `zeros_local.run`, taking the CLI's argv
(`cli-parse.ts`; `["guide"]` returns the skill). The brief before each turn and
the skill lead with the tool: it runs in the engine, so the first call works
in every sandbox and approval mode; it reads a `--message-file` inside the
chat's folder or added directories (symlinks resolved), never elsewhere. The
shell CLI is the same grammar plus stdin. A sandboxed shell (Codex
workspace-write, any shell without network) cannot open the loopback
connection, and agents reach for the shell first whatever the brief says, so
the first attempt used to fail with `NO_CAPABILITY` and only an escalated
retry worked. The CLI now falls back, only on a denied connect, to the
execution's drop folder (`ZEROS_LOCAL_DROPBOX`, 0700 under the engine's
`$TMPDIR`, which these sandboxes keep writable): it writes `<id>.req`
atomically, the engine claims it by rename, checks the bearer against the
folder's own execution and writes `<id>.res`. An unclaimed request is
withdrawn after 3 s and reported as not sent. A read-only shell (Plan) still
answers `NO_CAPABILITY` and points at the tool. The folder is removed when the
execution ends.

The engine creates response temporaries exclusively, without following links,
and confines claims, publication and cleanup to the drop directory. Linux uses
pinned directory descriptors; macOS uses its kernel no-follow path resolver.
If that resolver is unavailable, admission omits this optional transport and
keeps HTTP and `zeros_local.run` available. Cleanup removes flat transport files
and never recursively traverses agent-created directories. Tool message files
are opened without following any path component after canonical containment is
checked; type, size and bounded reads use that same descriptor, so replacing a
file or directory cannot redirect a read to the host.

The engine decides every call, so providers do not ask first: Claude treats
`zeros_local` as an engine control tool outside Plan unless the user's own
ask/deny rule matches; Codex receives
`default_tools_approval_mode = "approve"` for that server; Cursor runs MCP
tools without cards. Tool calls get a 660 s deadline (Codex
`tool_timeout_sec`, Claude SDK `timeout`), above the 600 s tool wait cap.

A capability acts for its execution only. Reads work any time; starting,
messaging, cancelling and approving require the caller's own running,
unstopped turn (`assertActiveTurn`), and Plan callers may only read, answer
questions and deny.

## What a chat can see

There are no orchestration consent cards; visibility is the boundary
(`visibility.ts`, recomputed from the database on every call). A chat sees:

- itself and its family — every chat in the same created-by tree, any depth;
- every chat tab in any workspace a family member lives in or the family
  created;
- every chat or workspace shared with any family member. A link the user
  writes in a message shares it (the engine's own receiver is never a person).
  An agent's message shares only links its sender can see, and always the
  sender itself, so the recipient can reply.

Everything else answers `NOT_FOUND`. A link from another channel's scheme names
another database and is refused. `repo list` lists every repository added to
Zeros, because creating a workspace in one is allowed.

## New chats

`spawn-settings.ts` resolves a child's settings. With no flags it copies the
creator: agent, model id (even one the curated catalog does not name), the
effort the picker would run for it (a retired tier clamps like the
composer's `effectiveEffort`), Fast, the exact native mode and, in the same
folder, extra directories. Flags are validated against the picker's own
rules: curated rows decide which models exist; live discovery overlays
capabilities and, only when account-scoped and complete, eligibility. The
engine keeps a pure copy of those rules, and
`__tests__/spawn-settings-parity.test.ts` compares it with the renderer's
`modelsForAgent` and `envForChatSettings`. A new chat of another agent
starts on the user's default model (`[models] default` / `default_agent`)
when that agent owns it; a saved null model (a legacy row) runs what the
renderer freezes it to. A child never gets a higher
permission level than its creator (Plan < Ask < Auto < Full); another
provider gets its broadest mode at or below that level. Provider credentials
still come from the engine's trusted fallback (`settings/provider-env.ts`).

A new chat row is written with its first message, so the renderer never
treats it as pristine, and with `--title` or "New chat". Zeros names "New
chat" / "Untitled" Local chats from their first real prompt (a person's or an
agent's, never a note) once the agent answers or the turn ends, whether or not
the tab is open: the chat surface names the one in view, and an app-level
backfill (`chat-title-backfill.ts`) asks the engine for the others
(`chats.titleSeeds`, desktop only). A busy or failed title request is retried
twice, spaced, then the prompt's opening words name the chat. It appears through the ordinary `DB_CHANGED`
`chats` reconcile and does not take focus.

An agent that cannot connect never gets a tab. Before any row (or, for
`workspace create` with a chat, any worktree) exists, the selected account is
checked with the gateway's own gate (`selectedAccountConnected`); a signed-out
or expired account answers `AUTH_REQUIRED`. If the first bind or prompt still
fails before the provider ran (it could not sign in, launch or open a session),
the tab is removed with its half-bound execution and the receipt keeps the
error without a link. A provider that answered — a rate limit, any turn
failure after acceptance — keeps its tab.

## Delivery

`engine-ports.ts` reuses the desktop's handlers through a private receiver
(`local-orchestration:<uuid>`, kind `local`, never registered with the router):

1. If the chat has no live execution, `AGENT_LOAD_SESSION` with its provider
   binding, or `AGENT_NEW_SESSION`.
2. `AGENT_PROMPT`. The handler records the accepted turn before its first
   await, so acceptance is read synchronously; `already responding` means
   busy, a session-expired reply binds once more.

Create and send wait up to 5 s, then answer `starting` (a new turn) or
`pending` (a steer the running turn has not consumed yet); the receipt records
the outcome either way, and a retry with the same request id reports it
instead of sending again. A working chat is steered with `AGENT_STEER`
(`delivered`, `pending`, `unknown`, or `BUSY` when known not delivered),
never queued.
Agent messages are labelled `[Zeros] From agent "<title>" (<link>):` before
the text for the provider; provenance is also stored per message. The
recipient's transcript stores something else: the facade stages a
presentation under the message id (`stagePresentation`), and the engine
records the input as one whole user row (`recordLocalUserMessage`) — the
sender's own text with `localFrom` (chat, title, agent, link), or a note's
plain summary with `localNote` (event, status, card) — and pushes it at once
as a `user_message_recorded` session update, so it streams mid-turn like a
tool call instead of appearing when the turn ends. Renderers draw `localFrom`
with a right-aligned "Sent from" header above the bubble and `localNote` as a
compact tool-style row.
Notifications keep their presentation in `note_json` (migration 42). Rows
written before this change keep their labelled text.

The user's Stop (an `AGENT_CANCEL` from any real client, or a Stop while the
provider is still starting, `AGENT_CLOSE_SESSION` with `userStop`) blocks agent
messages to that chat with `STOPPED_BY_USER` until the user sends again. It
also fences agent work already on its way: every facade bind and prompt
rechecks it (a new workspace's first message after setup included), and it
retires the chat's outstanding notes, even one mid-delivery. Stopping a
parent never stops its children. Steering receipts keep every
identity of an execution up to 8,192 (`steering-receipts.ts`), so a retried
steer never runs twice and a long-running coordinator is not capped at the
old 256.

New workspaces use `workspace.prepareCreate` → `workspace.create`. In the
caller's repository a workspace stacks on the caller's branch (or commit when
detached); in another repository it starts from the default base, like a
user-created workspace. Setup runs; run-on-create actions do not. A first
message waits for seeding and setup before it is sent.

## Waiting, following and cards

`chat wait` subscribes before it reads and rechecks every second; it returns
on the end of the awaited turn or, by default, on a pending card. Every
recheck rebuilds the caller's authority, so a target that moves out of view,
an owner change or a closed gate ends the wait with the normal error, never
its content. Waits are
capped at 120 s from the CLI and 600 s from the tool (50 s from Cursor's tool,
whose MCP client has no per-call deadline); a timeout never touches the target
(the CLI exits 5).

`--notify` and `chat follow` record follows; the engine then puts one
`[Zeros]` note into the follower per event (`done`, `question`, `permission`),
steering it while it works or starting a turn when idle. Each note is checked
like a fresh call (gate open, both chats Local, the source still visible to
the follower) and retired otherwise. A note is claimed before it is sent, so a
crash mid-delivery leaves it `unknown` rather than sending it twice; only a
known non-delivery is retried. A turn that only delivered a note never
notifies anyone, so mutual follows cannot loop.

Cards are the engine's pending permission and question requests, projected by
`cards.ts` with their full content. Anyone who can see a chat may answer its
questions and deny its permissions. Approving a permission, approval or plan
requires the caller to be in Auto or Full and at least the asking chat's level
(`APPROVAL_GUARD`); an approval sent as a question needs an option, not free
text. An approved plan returns the chat to its pre-plan mode, as the composer
does. The first answer wins (`ALREADY_SETTLED`). The winning agent answer is
recorded (`local_orchestration_card_answers`, shown as `answeredCards` by
`chat status`) and its settle event carries an engine-derived `answeredBy`
for renderers; showing it in the chat is a later UI change.

`chat messages --after` pages over stored rows by a chat-scoped cursor. A
streamed reply updates its row in place, so after a wait reread `--last` (or
the turn) rather than expecting later pages to carry edits.

## Links

`zeros://chat/<id>` and `zeros://workspace/<id>`, with the channel's scheme
(`zeros`, `zeros-alpha`, `zeros-beta`, `zeros-dev`). Chat and workspace menus
offer **Copy link** for Local (Personal) owners while the feature is open;
folder workspaces use `folder:<projectId>`.

Opening a link only navigates (`electron/deep-link.ts` → `local-navigation`
event → `shell/local-link-navigation.tsx`). Electron keeps the latest intent
until the app window's renderer asks for it (`local_navigation_ready`), so a
cold start or a closed window still lands. The renderer reads a fresh Local
snapshot, refuses organization, cloud, archived, missing and unknown targets
with the existing notices, and selects the workspace and tab in one store
update. Until the user interacts, the destination stays passive: no default
tab, no provider start or resume (an existing live execution may be adopted),
no terminal-agent start and no setup.

## Persisted records

Migration 41 adds `local_orchestration_*` tables (`db/local-orchestration.ts`):
family links, family-created workspaces, shares, follows, notifications
(at most once per follower, source, event and key), request receipts (a
`--request-id` replays; different content is `REQUEST_CONFLICT`; a refused
request answers its retry with the same error; work that was dispatching when
the engine stopped reads `unknown`, earlier states `interrupted`; internal
steps such as a new workspace's first chat use ids no caller can name),
message provenance, agent card answers, and the user's Stop.

Receipt state takes precedence over retained chat metadata: `refused` and
`unknown` retries return errors even when the tab exists. Failed sends retain
their original error code, message and retry details, including outcomes that
arrive after the caller received `starting`.

## Rollout

`localOrchestration` starts at `internal`. A renderer push without the key
still applies and keeps the feature closed. Admission happens when an
execution starts, so opening the feature reaches chats on their next session.
