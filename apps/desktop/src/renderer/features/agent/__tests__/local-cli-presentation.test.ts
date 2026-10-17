import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Terminal } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import type { AgentToolMessage } from "@zeros/protocol/agent-messages";
import { LOCAL_COMMANDS } from "@zeros/protocol/local-orchestration";
import { localCliPresentation } from "../renderers/local-cli-presentation";
import { EventRow } from "../renderers/event-row";
import { LocalLinksContext } from "../local-links/context";
import { TooltipProvider } from "../../../shared/ui/primitives/tooltip";
import type { RendererContext } from "../renderers/types";

const tool = (
  rawInput: unknown,
  extra: Partial<AgentToolMessage> = {},
): AgentToolMessage => ({
  kind: "tool",
  id: "tool",
  toolCallId: "call",
  title: "Bash",
  toolKind: "execute",
  status: "completed",
  createdAt: 1,
  updatedAt: 2,
  rawInput,
  ...extra,
});
const present = (command: string) =>
  localCliPresentation(tool({ command }), "zeros-dev");
const cases = [
  ["whoami", "Identity checked"],
  ["models", "Models listed"],
  ["repo.list", "Repos listed"],
  ["workspace.list", "Workspaces listed"],
  ["workspace.status", "Workspace status"],
  ["workspace.create", "Workspace created"],
  ["chat.list", "Chats listed"],
  ["chat.create", "Chat created"],
  ["chat.status", "Chat status"],
  ["chat.wait", "Waited for chat"],
  ["chat.messages", "Chat read"],
  ["chat.cancel", "Chat stopped"],
  ["chat.follow", "Following chat"],
  ["chat.unfollow", "Unfollowed chat"],
  ["message.send", "Message sent"],
  ["card.list", "Cards listed"],
  ["card.answer", "Card answered"],
  ["link", "Link read"],
];

describe("Local CLI tool presentation", () => {
  it("covers the shared command vocabulary", () =>
    expect(cases.map(([command]) => command)).toEqual(LOCAL_COMMANDS));
  it.each(cases)("names %s consistently", (command, label) => {
    expect(present(`zeros local ${command.replace(".", " ")}`)?.label).toBe(
      label,
    );
  });
  it.each([
    "zeros local chat status child",
    '"$ZEROS_LOCAL_CLI" local chat status child',
    '"${ZEROS_LOCAL_CLI}" local chat status child',
    "/bin/zsh -lc 'zeros local chat status child'",
    "/bin/zsh -lc '\"$ZEROS_LOCAL_CLI\" local chat status child'",
    "/Applications/Zeros/bin/zeros local chat status child",
  ])("recognizes a literal invocation: %s", (command) => {
    expect(present(command)).toMatchObject({
      command: "chat.status",
      targets: [{ href: "zeros-dev://chat/child" }],
    });
  });
  it.each([
    "echo zeros local chat status child",
    "zeros local whoami && echo done",
    "zeros local whoami | cat",
    "zeros local whoami > output",
    "zeros local whoami\necho done",
    "zeros local chat status $CHAT",
    "zeros local chat status $(echo child)",
    '"$OTHER_CLI" local whoami',
    "zeros cloud chat list",
    "/bin/zsh -lc 'zeros local whoami' extra",
    "cd /repo && zeros local whoami",
    "zeros local message send child --message-file - <<'EOF'\nHi\nEOF\necho done",
    "zeros local message send child --message-file - <<'EOF' && echo done\nHi\nEOF",
    "zeros local message send child --message-file - <<EOF\n$(echo command)\nEOF",
    "zeros local message send child --message-file - <<EOF\n`echo command`\nEOF",
    "zeros local message send child --message-file - <<'EOF'\nUnterminated",
    "zeros local message send child --message-file - <<'EOF'\nHi\nEOF; echo done",
    "zeros local message send child --message-file - <<'EOF' >output\nHi\nEOF",
    "zeros local message send child --message-file - 2<<'EOF'\nHi\nEOF",
    "zeros local whoami <<'EOF'\nHi\nEOF",
    "zeros local message send child --message-file -\n<<'EOF'\nHi\nEOF",
    "/bin/zsh\n-lc 'zeros local chat status child'",
  ])("leaves ambiguous or unrelated shell commands unchanged: %s", (command) =>
    expect(present(command)).toBeNull(),
  );

  it.each([
    { command: "zeros local message send zeros-dev://chat/child --request-id arch-audit-progress --message-file - <<'EOF'\nProgress: $literal, `text`, && not a command\nEOF" },
    { command: 'zeros local message send zeros-dev://chat/child --request-id arch-audit-progress --message-file - <<"EOF"\nProgress\nEOF\n' },
    { cmd: "zeros local message send zeros-dev://chat/child --message-file - <<EOF\nProgress\nEOF" },
    { command: ["/bin/zsh", "-lc", "zeros local message send zeros-dev://chat/child --message-file - <<-'EOF'\n\tProgress\n\tEOF"] },
    { command: "/bin/zsh -lc \"zeros local message send zeros-dev://chat/child --message-file - <<'EOF'\nProgress\nEOF\"", cwd: "/repo", commandActions: [{ type: "unknown" }] },
    { command: "zeros local message send zeros-dev://chat/child \\\n --message-file - 0<<'EOF'\nProgress\nEOF" },
  ])("recognizes single stdin-heredoc calls in provider shell shapes: %j", (input) => {
    expect(localCliPresentation(tool(input), "zeros-dev")).toMatchObject({
      command: "message.send", label: "Message sent",
      targets: [{ href: "zeros-dev://chat/child" }],
    });
  });

  it("retains the recorded Codex wrapper and Cursor shell shape without relying on the title", () => {
    const command = 'zeros local message send zeros-dev://chat/child --message "Progress" --request-id arch-audit-progress --json';
    for (const rawInput of [{ command }, { command: `/bin/zsh -lc '${command}'`, cwd: "/repo", commandActions: [{ type: "unknown", command }] }]) {
      expect(localCliPresentation(tool(rawInput, { title: `Running ${command.slice(0, 60)}` }), "zeros-dev")?.label).toBe("Message sent");
    }
  });

  it("skips prompt/flag values, recognizes help and keeps multiple wait operands", () => {
    expect(
      present(
        'zeros local message send child --message "--help zeros-dev://chat/wrong"',
      )?.targets,
    ).toEqual([{ href: "zeros-dev://chat/child" }]);
    expect(
      present(
        "zeros local --json chat wait one zeros-dev://chat/two --turn turn --timeout 8",
      )?.targets,
    ).toEqual([
      { href: "zeros-dev://chat/one" },
      { href: "zeros-dev://chat/two" },
    ]);
    expect(present("zeros local workspace --help")?.label).toBe(
      "Local CLI help",
    );
    expect(present("zeros local link ws_child")?.targets).toEqual([
      { href: "zeros-dev://workspace/ws_child" },
    ]);
    expect(
      present("zeros local chat list --workspace=folder:project")?.targets,
    ).toEqual([{ href: "zeros-dev://workspace/folder%3Aproject" }]);
  });

  it.each([
    {
      rawInput: {
        server: "zeros_local",
        tool: "run",
        arguments: { args: ["chat", "status", "child"] },
      },
      title: "zeros_local:run",
    },
    {
      rawInput: { args: ["chat", "status", "child"] },
      title: "mcp__zeros_local__run",
    },
    {
      rawInput: {
        providerIdentifier: "zeros_local",
        toolName: "run",
        args: { args: ["chat", "status", "child"] },
      },
      title: "MCP run",
    },
  ])("reads native MCP args for every adapter shape", ({ rawInput, title }) => {
    expect(
      localCliPresentation(
        tool(rawInput, { toolKind: "mcp", title }),
        "zeros-dev",
      ),
    ).toMatchObject({
      command: "chat.status",
      targets: [{ href: "zeros-dev://chat/child" }],
    });
  });

  it("does not accept unqualified names or a foreign server's misleading title", () => {
    expect(
      localCliPresentation(
        tool({ args: ["whoami"] }, { toolKind: "mcp", title: "run" }),
        "zeros-dev",
      ),
    ).toBeNull();
    expect(
      localCliPresentation(
        tool(
          { server: "foreign", tool: "run", args: ["whoami"] },
          { toolKind: "mcp", title: "mcp__zeros_local__run" },
        ),
        "zeros-dev",
      ),
    ).toBeNull();
  });

  const envelope = {
    ok: true,
    protocol: 1,
    result: {
      chatId: "created",
      link: "zeros-dev://chat/created",
      title: "Review",
      agent: "claude",
    },
  };
  it.each([
    envelope,
    JSON.stringify(envelope),
    { stdout: JSON.stringify(envelope), exitCode: 0 },
    { content: [{ type: "text", text: JSON.stringify(envelope) }] },
    { structuredContent: envelope },
    { result: { value: { output: JSON.stringify(envelope), exitCode: 0 } } },
  ])(
    "reads a creation target from a real successful result wrapper",
    (rawOutput) => {
      expect(
        localCliPresentation(
          tool(
            { command: "zeros local chat create --message Test --json" },
            { rawOutput },
          ),
          "zeros-dev",
        )?.targets,
      ).toEqual([
        {
          href: "zeros-dev://chat/created",
          fallback: { title: "Review", agentId: "claude" },
        },
      ]);
    },
  );
  it("reads workspace + child targets, including canonical tool content blocks", () => {
    const result = {
      workspace: {
        workspaceId: "ws_new",
        link: "zeros-dev://workspace/ws_new",
      },
      chat: envelope.result,
    };
    const content = [
      {
        type: "content" as const,
        content: {
          type: "text" as const,
          text: JSON.stringify({ ...envelope, result }),
        },
      },
    ];
    expect(
      localCliPresentation(
        tool(
          { command: "zeros local workspace create --repo current --json" },
          { content },
        ),
        "zeros-dev",
      )?.targets.map((target) => target.href),
    ).toEqual(["zeros-dev://workspace/ws_new", "zeros-dev://chat/created"]);
    expect(
      localCliPresentation(
        tool(
          { command: "zeros local chat create --message Test" },
          { rawOutput: { ok: false, protocol: 1, error: { code: "BUSY" } } },
        ),
        "zeros-dev",
      )?.targets,
    ).toEqual([]);
  });

  it("uses running voice, Terminal icon and sibling pills without changing raw details", () => {
    const message = tool(
      { command: "zeros local chat wait child --timeout 8" },
      { status: "in_progress" },
    );
    const context = {
      enabled: true,
      scheme: "zeros-dev" as const,
      index: null,
      navigate: vi.fn(),
    };
    const ctx = { attachmentImagesActive: false } as RendererContext;
    const html = renderToStaticMarkup(
      h(
        TooltipProvider,
        null,
        h(
          LocalLinksContext.Provider,
          { value: context },
          h(EventRow, {
            message,
            ctx,
            detail: h("pre", null, "zeros-dev://chat/raw"),
          }),
        ),
      ),
    );
    expect(html).toContain("Waiting for chat");
    expect(html).toContain("lucide-terminal");
    expect(html).toContain('data-local-link-pill="chat"');
    expect(html).not.toMatch(
      /<button[^>]*>[^]*?<button[^>]*>[^]*?<\/button>[^]*?<\/button>/,
    );
    const open = renderToStaticMarkup(
      h(
        TooltipProvider,
        null,
        h(
          LocalLinksContext.Provider,
          { value: context },
          h(EventRow, {
            message,
            ctx,
            defaultOpen: true,
            detail: h("pre", null, "zeros-dev://chat/raw"),
          }),
        ),
      ),
    );
    expect(open).toContain("<pre>zeros-dev://chat/raw</pre>");
  });

  it("uses the standard error preview while leaving target pills in their normal palette", () => {
    const command =
      "zeros local message send zeros-dev://chat/child --message Update";
    const html = renderToStaticMarkup(
      h(
        TooltipProvider,
        null,
        h(
          LocalLinksContext.Provider,
          {
            value: {
              enabled: true,
              scheme: "zeros-dev",
              index: null,
              navigate: vi.fn(),
            },
          },
          h(EventRow, {
            message: tool({ command }, { status: "failed" }),
            ctx: { attachmentImagesActive: false } as RendererContext,
            detail: h("pre", null, "Target unavailable"),
          }),
        ),
      ),
    );
    expect(html).toContain("Error");
    expect(html).toContain(command);
    const pills = html.match(/<button[^>]*data-local-link-pill[^>]*>/g)!;
    expect(pills).toHaveLength(1);
    expect(pills[0]).not.toContain("bg-red-bg");
    expect(pills[0]).not.toContain("text-red-");
    const preview = html.match(/<span data-tool-preview=""[^>]*>/)![0];
    expect(preview).toContain("bg-red-bg text-red-primary");
    expect(preview).not.toContain("font-mono");
  });

  it.each([
    tool({ command: "zeros local chat status zeros-dev://chat/child && echo zeros-dev://workspace/ws_child" }),
    tool({ server: "other", tool: "lookup" }, { toolKind: "mcp", title: "Inspect zeros-dev://chat/child" }),
  ])("places generic tool link pills before a plain preview without relabelling the call", (message) => {
    const html = renderToStaticMarkup(h(TooltipProvider, null,
      h(LocalLinksContext.Provider, { value: { enabled: true, scheme: "zeros-dev", index: null, navigate: vi.fn() } },
        h(EventRow, { message, ctx: { attachmentImagesActive: false } as RendererContext,
          detail: h("pre", null, "Raw details"),
          ...(message.toolKind === "mcp" ? { meta: { Icon: Terminal, label: "MCP", target: "Inspect zeros-dev://chat/child", expandable: true } } : {}),
        }),
      ),
    ));
    expect(html).not.toContain("Chat status");
    expect(html).toContain('data-local-link-pill="chat"');
    const previewIndex = html.indexOf('data-tool-preview=""');
    expect(previewIndex).toBeGreaterThanOrEqual(0);
    expect(html.indexOf('data-local-link-pill="chat"')).toBeLessThan(previewIndex);
    expect(html.slice(previewIndex)).not.toContain("data-local-link-pill");
    expect(html.slice(previewIndex)).toContain("zeros-dev://chat/child");
  });

  it("keeps generic preview link work bounded to the displayed metadata", () => {
    const message = tool({ command: `echo ${"x".repeat(300)} zeros-dev://chat/hidden` });
    const html = renderToStaticMarkup(h(TooltipProvider, null,
      h(LocalLinksContext.Provider, { value: { enabled: true, scheme: "zeros-dev", index: null, navigate: vi.fn() } },
        h(EventRow, { message, ctx: { attachmentImagesActive: false } as RendererContext, detail: h("pre", null, "Raw details") }),
      ),
    ));
    expect(html).not.toContain("data-local-link-pill");
    expect(html).toContain('data-tool-preview=""');
  });
});
