# Automatic chat titles

The desktop sends `POST /v1/chat-titles` to its existing
`VITE_CONTROL_PLANE_URL`, authenticated with the user's Zeros access token.
The control plane calls OpenAI's Responses API with `gpt-6-luna`, reasoning
`none`, `max_output_tokens: 32`, and `store: false`. No tools, agent processes,
repository instructions, file contents, or conversation history are included.
The system instruction is fixed on the server; clients cannot select a model,
endpoint, credentials, or generation parameters.

Only the first admitted user message's display text is eligible, after the turn
settles and the chat is visible. Inputs up to 500 Unicode code points are kept
whole (after trimming outer whitespace). Longer inputs use exactly the first
400 and last 100 code points, without an extra separator. The server rejects
inputs exceeding 500 rather than accepting an unbounded payload. Attachment-only
or blank first messages do not use a later message as a substitute.

Valid titles contain 3–5 whitespace-separated words, at most 80 code points.
Wrapping quotes, simple markdown and emoji are removed; extra words are clamped
to five. Refusals, diagnostics, malformed or incomplete responses are rejected.
On missing configuration/authentication, timeout, rate limit, network failure,
or invalid output, the chat retains its seeded title. There is no automatic
retry, paid provider fallback, or prompt-snippet fallback. Manual renames and
deleted/replaced chat owners win over delayed responses; account changes are
checked again before applying the compare-and-swap rename.

An unavailable sign-in session does not consume the chat's HTTP attempt. While
the chat is active and eligible, a later authentication event starts naming;
the listener is removed when the surface becomes inactive. Repeated sign-in
events still share the same request.

The renderer retains up to 1,000 attempted chat/message identities per process.
The server deduplicates by verified user, chat and first-message ID, checks a
prompt hash against that identity, and caches up to 10,000 results (including
failures) for 24 hours. Raw prompts and credentials are not cached or logged.
Generation is capped at eight concurrent requests per server, 20 requests per
user per minute and 500 per day. These caches and limits are process-local,
like the existing control-plane limiter: deployments reset them, and replicas
do not share them. Use shared storage before relying on them as fleet-wide
billing limits. The OpenAI call times out after 10 seconds; the desktop allows
15 seconds for the HTTP request.

## Credentials and testing

For hosted users, set **`CHAT_TITLE_OPENAI_API_KEY` in the Railway control-plane
service's secret environment**, separately for each deployment environment.
Deploy the backend and desktop changes. All signed-in users of that backend
then get naming regardless of which coding provider they use; they do not need
an OpenAI API key or Codex subscription. The key is never distributed to users,
their cloud workers, the renderer bundle, or `VITE_*` variables.

For local testing, put that variable in **`apps/control-plane/.env`** (ignored by
Git), or inject it into the test process environment. Do not paste a key into
chat, a commit, or a shell command. Run:

```sh
pnpm --dir apps/control-plane smoke:chat-titles
```

This sends at most three synthetic prompts through the same OpenAI request
implementation and prints only their validated titles. It stops on the first
failure. Unit tests mock OpenAI and require no credentials. Full app testing
also requires the usual control-plane database/auth configuration and a desktop
build pointed at that backend. The smoke command does not deploy anything.

The direct API smoke does **not** prove that an installed desktop build or its
hosted backend contains this feature. A local `.env` is read by the smoke
command; it does not configure Railway. Verify all three parts before claiming
that a user's app is wired: the running desktop includes the title request, its
configured control plane includes `/v1/chat-titles`, and that service has the
server key. Pulling `origin/main` does not install unmerged workspace changes.

`pnpm test:ui-smoke` also checks the real renderer request, HTTP title router,
workspace state update, and visible chat tab, including delayed sign-in and the
input/output limits. Authentication and OpenAI output are fixtures,
so this test makes no paid requests. It does not replace a deployed-app check.

The title limit is **3–5 words per title**, not 3–5 output tokens. The dashboard
aggregates usage across requests, and tokenization plus response formatting can
make token counts larger than word counts. `max_output_tokens: 32` is a ceiling,
not a fixed charge; successful output is still sanitized to at most five words.
See OpenAI's [output-token accounting](https://developers.openai.com/api/docs/guides/token-counting).

OpenAI documents the exact [Luna model and supported reasoning settings](https://developers.openai.com/api/docs/models/gpt-6-luna).
Character limits bound input size but are not token counts; actual cost depends
on tokenization, output length and current API pricing.

## Retired implementation

The Haiku/Luna/Composer title picker, connectivity fallback chain, 15-second
provider-start scheduler, gateway title method, and all three adapters'
`generateText` implementations are removed. `models.chat_title_model` remains
readable for older settings files, is ignored, and is removed by the next model
preference save. The legacy localStorage `chat-title-model` value is ignored.
`AGENT_GENERATE_TITLE` / `AGENT_TITLE_GENERATED` remain wire-compatible: the engine
returns a null title without using credentials or launching an agent. The
serialized `generation.oneShotText` descriptor remains, marked unavailable.
