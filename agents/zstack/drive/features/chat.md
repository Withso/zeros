# Chat, composer and transcript

**What it is.** A workspace chat combines provider/model selection, a composer,
streamed work, tool rows and durable conversation history.

**Reach.** Select the intended owner/workspace and open its chat tab. Use the
composer's **Model:** control for the selected provider's real catalog. Provider
authentication is separate from the account-free Local app.

**Drive.** Check a draft survives a tab switch without appearing in another
chat. If a real provider turn is authorized, send one short deterministic prompt
and wait for its visible completed response; test **Stop** only on the turn you
started. Expand a settled work group and inspect its tool/result rows. Reopen
the same chat to check history; do not infer completion from a launch receipt.

**Linux fixture.** Open `harness-claude-runtime-ui.html`; wait for
`#claude-transcript-recovery [data-authentication-status="signed-in"]`.
Inside `#claude-transcript-recovery`, click **Show settled recovery**. The
**1 message, 3 agents** summary should be collapsed; expand it and verify the
usage notice and work return. The fixture controls replay known events without
starting agents. `scripts/ui-smoke-claude-runtime-ui.mjs` (`claude-runtime-ui`)
checks recovery and waiting; `composer-editor` and `composer-send-failures`
cover editing and failed sends. Codex has its own `codex-runtime-ui` fixture.

**Observable end state.** The intended chat owns its draft/response, completed
work remains inspectable, and an error or interrupted turn stays visible.
Capture the settled summary and its expanded evidence. A real-turn receipt also
names the provider and confirms completion/history through the real transport.

**Gotchas.** Fixture “Signed in” is simulated. Model names/effort choices come
from the current catalog, not this map. A background monitor is not active
provider work. Cloud history can be read while stopped; Send/Stop have explicit
pending/wake semantics. Never route a cloud chat through a Local engine as a
fallback or expose provider credentials in evidence.

Sources: `apps/desktop/src/renderer/features/agent/agent-chat.tsx`,
`docs/agent-tool-presentation.md`,
`apps/desktop/src/renderer/harnesses/harness-claude-runtime-ui.tsx`.
