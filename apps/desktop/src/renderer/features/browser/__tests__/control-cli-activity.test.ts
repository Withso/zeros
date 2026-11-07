import { Globe, SquareMousePointer, Terminal } from "lucide-react";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type {
  AgentMessage,
  AgentToolMessage,
} from "../../agent/use-agent-session";
import {
  formatToolDuration,
  nativeCodexBrowserPresentation,
} from "../../agent/renderers/event-meta";
import { NativeBrowserToolRow } from "../../agent/renderers/event-row-renderer";
import { countEventSummary, summaryIcons } from "../../agent/renderers/tool-summary";
import type { RendererContext } from "../../agent/renderers/types";
import { TooltipProvider } from "../../../shared/ui/primitives/tooltip";
import {
  CONTROL_CLI_BOOLEAN_FLAGS,
  CONTROL_CLI_VERBS,
} from "../../../../engine/agent-control/control-cli";
import {
  browserActivityGroupStatus,
  browserToolActivity,
  groupBrowserToolActivity,
} from "../browser-tool-activity";
import { CONTROL_CLI_PRESENTATION_GRAMMAR } from "../control-cli-activity";

function shell(
  id: string,
  rawInput: Record<string, unknown>,
  extra: Partial<AgentToolMessage> = {},
): AgentToolMessage {
  return {
    id,
    kind: "tool",
    toolCallId: id,
    title: "Bash",
    toolKind: "execute",
    status: "completed",
    rawInput,
    createdAt: 1_000,
    updatedAt: 2_000,
    settledAt: 1_839,
    ...extra,
  };
}

const run = (command: string, extra: Partial<AgentToolMessage> = {}) =>
  shell("call", { command }, extra);

const textOutput = (text: string): Partial<AgentToolMessage> => ({
  content: [{ type: "content", content: { type: "text", text } }],
});

describe("zeros computer and zeros browser shell rows", () => {
  it("reads commands with the CLI's own flags and verbs", () => {
    const sorted = (values: readonly string[]) => [...values].sort();
    expect(sorted(CONTROL_CLI_PRESENTATION_GRAMMAR.booleanFlags)).toEqual(
      sorted(CONTROL_CLI_BOOLEAN_FLAGS),
    );
    expect(sorted(CONTROL_CLI_PRESENTATION_GRAMMAR.verbs.computer)).toEqual(
      sorted(CONTROL_CLI_VERBS.computer),
    );
    expect(sorted(CONTROL_CLI_PRESENTATION_GRAMMAR.verbs.browser)).toEqual(
      sorted(CONTROL_CLI_VERBS.browser),
    );
  });

  it("presents each provider's shell envelope as computer activity", () => {
    const expected = {
      surface: "computer",
      tool: "open",
      label: "Opened link",
      rowTarget: "cursor.com",
      appId: "com.google.Chrome",
      surfaceScope: "computer",
      external: true,
    };
    const command =
      "zeros computer open --app com.google.Chrome https://cursor.com";
    // Claude Bash and Cursor shell: the command string.
    expect(
      browserToolActivity(
        shell("claude", { command, description: "Open cursor.com in Chrome" }),
      ),
    ).toMatchObject(expected);
    // Codex: a literal login-shell launcher, as a string or as argv.
    expect(
      browserToolActivity(shell("codex", { command: `/bin/zsh -lc '${command}'` })),
    ).toMatchObject(expected);
    expect(
      browserToolActivity(
        shell("codex-argv", { command: ["/bin/zsh", "-lc", command] }),
      ),
    ).toMatchObject(expected);
    // The packaged launcher's absolute path is the same command.
    expect(
      browserToolActivity(
        run(
          "/Applications/Zeros.app/Contents/Resources/bin/zeros computer open --app com.google.Chrome https://cursor.com",
        ),
      ),
    ).toMatchObject(expected);
  });

  it("names the app an action used, and never the text it typed", () => {
    expect(
      browserToolActivity(run('zeros computer open --app "Calculator"')),
    ).toMatchObject({ label: "Opened app", rowTarget: "Calculator" });
    const typed = browserToolActivity(
      run("zeros computer type --app Calculator '12*34='"),
    );
    expect(typed).toMatchObject({ label: "Typed", rowTarget: "Calculator" });
    expect(JSON.stringify(typed)).not.toContain("12*34");
    expect(
      browserToolActivity(
        run("zeros computer key --app=Calculator return --mods cmd"),
      ),
    ).toMatchObject({ label: "Pressed key", tool: "key", rowTarget: "Calculator" });
    expect(
      browserToolActivity(
        run("zeros computer shot --pid 4242 --window 7 --no-elements"),
      ),
    ).toMatchObject({ label: "Captured screenshot", tool: "screenshot" });
    expect(
      browserToolActivity(run("zeros computer shot --pid 4242"))?.rowTarget,
    ).toBeUndefined();
    expect(browserToolActivity(run("zeros computer apps --running"))).toMatchObject(
      { label: "Listed apps" },
    );
    // A name is not a bundle ID, so no app icon is guessed from it.
    expect(
      browserToolActivity(run("zeros computer click --app chrome --element s0a1b2c3d:4"))
        ?.appId,
    ).toBeUndefined();
  });

  it("presents the Zeros browser commands as browser activity", () => {
    const open = browserToolActivity(
      run("zeros browser open https://example.com/docs"),
    );
    expect(open).toMatchObject({
      tool: "open",
      label: "Opened",
      url: "https://example.com/docs",
      rowTarget: "example.com",
      phase: "browse",
    });
    expect(open?.surface).toBeUndefined();
    expect(open?.external).toBeUndefined();
    expect(
      browserToolActivity(run('zeros browser read --find "Example Domain"')),
    ).toMatchObject({ label: "Read page", tool: "snapshot" });
    expect(browserToolActivity(run("zeros browser click e12"))).toMatchObject({
      label: "Clicked",
    });
    const typed = browserToolActivity(
      run("zeros browser type e3 'hunter2' --clear"),
    );
    expect(typed).toMatchObject({ label: "Typed" });
    expect(JSON.stringify(typed)).not.toContain("hunter2");
    expect(browserToolActivity(run("zeros browser close"))).toMatchObject({
      label: "Finished browser session",
      phase: "handoff",
    });
  });

  it("keeps compound commands, expansions, help and unknown verbs as shell rows", () => {
    for (const command of [
      "echo zeros computer open --app Calculator",
      "zeros computer open --app Calculator && echo done",
      "zeros computer open --app Calculator | cat",
      "zeros computer type --app Notes $SECRET",
      "zeros computer type --app Notes \"$(pbpaste)\"",
      "zeros computer open --app Calculator\necho done",
      "zeros computer",
      "zeros computer --help",
      "zeros computer help",
      "zeros computer open --help",
      "zeros browser -h",
      "zeros computer explode",
      "zeros computer shot --app",
      "zeros computer --continue batch -",
      "zeros local chat list",
      "zeros-computer open --app Calculator",
      "cat steps.json | zeros computer batch -",
    ]) {
      expect(browserToolActivity(run(command)), command).toBeNull();
    }
    // Only shell executions qualify; a read of the same text is not one.
    expect(
      browserToolActivity({
        ...run("zeros computer apps"),
        toolKind: "read",
      }),
    ).toBeNull();
  });

  it("counts the steps of a literal batch heredoc", () => {
    const batch = browserToolActivity(
      run(
        [
          "zeros computer batch - <<'EOF'",
          '[["open","--app","com.apple.calculator"],["type","--app","com.apple.calculator","12*34="]]',
          "EOF",
        ].join("\n"),
      ),
    );
    expect(batch).toMatchObject({
      surface: "computer",
      label: "Ran 2 steps",
      rowTarget: "com.apple.calculator",
      appId: "com.apple.calculator",
    });
    expect(JSON.stringify(batch)).not.toContain("12*34");
    expect(
      browserToolActivity(
        run(
          'zeros browser batch - <<EOF\n[["open","https://conductor.build/docs"]]\nEOF',
        ),
      ),
    ).toMatchObject({
      label: "Ran 1 step",
      url: "https://conductor.build/docs",
      rowTarget: "conductor.build",
    });
    expect(
      browserToolActivity(run("zeros computer batch steps.json")),
    ).toMatchObject({ label: "Ran steps" });
    // Expansion in an unquoted heredoc, malformed JSON, a nested batch and an
    // unknown step stay shell rows.
    for (const command of [
      'zeros computer batch - <<EOF\n[["type","--app","Notes","$SECRET"]]\nEOF',
      "zeros computer batch - <<'EOF'\nnot json\nEOF",
      "zeros computer batch - <<'EOF'\n[]\nEOF",
      "zeros computer batch - <<'EOF'\n[[\"batch\",\"-\"]]\nEOF",
      "zeros computer batch - <<'EOF'\n[[\"explode\"]]\nEOF",
    ]) {
      expect(browserToolActivity(run(command)), command).toBeNull();
    }
  });

  it("times a command from its --json report, else from when it settled", () => {
    expect(
      browserToolActivity(
        run(
          "zeros computer open --app chrome https://cursor.com --wait-title Cursor --json",
          textOutput(
            '{"ok":true,"command":"computer.open","ms":612,"text":"Opened","images":[],"data":{"app":"Google Chrome","bundleId":"com.google.Chrome","pid":1,"windowId":2,"title":"Cursor"}}\n',
          ),
        ),
      ),
    ).toMatchObject({ durationMs: 612, appId: "com.google.Chrome" });
    // Codex keeps the output beside its exit code.
    expect(
      browserToolActivity(
        run("zeros browser read --json", {
          rawOutput: {
            exitCode: 0,
            aggregatedOutput: '{"ok":true,"command":"browser.read","ms":95,"text":"x","images":[]}',
          },
        }),
      )?.durationMs,
    ).toBe(95);
    // A report for another command, or output that is not one JSON line, is
    // not this command's timing.
    expect(
      browserToolActivity(
        run(
          "zeros browser read --json",
          textOutput('{"ok":true,"command":"browser.open","ms":5}'),
        ),
      )?.durationMs,
    ).toBe(839);
    expect(
      browserToolActivity(run("zeros browser read", textOutput("Example Domain")))
        ?.durationMs,
    ).toBe(839);
    expect(
      browserToolActivity(
        run("zeros computer apps", { status: "in_progress", settledAt: undefined }),
      )?.durationMs,
    ).toBeUndefined();
    expect(formatToolDuration(839.4)).toBe("839ms");
    expect(formatToolDuration(7_400)).toBe("7.4s");
  });

  it("groups shell and tool-call actions of one burst and closes at narration", () => {
    const narration: AgentMessage = {
      id: "text",
      kind: "text",
      role: "agent",
      text: "Now the docs.",
      createdAt: 3,
    };
    const mcpClick: AgentToolMessage = {
      id: "mcp-click",
      kind: "tool",
      toolCallId: "mcp-click",
      title: "mcp__zeros_computer__click",
      toolKind: "mcp",
      status: "completed",
      rawInput: { pid: 42, element_token: "s0a1b2c3d:4" },
      createdAt: 2,
      updatedAt: 2,
    };
    const events: AgentMessage[] = [
      shell("open", {
        command: "zeros computer open --app com.google.Chrome https://cursor.com",
      }),
      mcpClick,
      narration,
      shell("browse", { command: "zeros browser open https://conductor.build/docs" }),
      shell("read", { command: "zeros browser read --find Install" }),
    ];
    const grouped = groupBrowserToolActivity(events, { closeTail: true });
    expect(grouped).toMatchObject([
      {
        kind: "browser-activity",
        surface: "computer",
        actions: [{ label: "Opened link" }, { label: "Clicked" }],
      },
      { kind: "event", id: "text" },
      {
        kind: "browser-activity",
        surface: "browser",
        actions: [{ label: "Opened" }, { label: "Read page" }],
      },
    ]);
    const last = grouped.at(-1);
    expect(
      last?.kind === "browser-activity" &&
        browserActivityGroupStatus(last.events, last.closed),
    ).toBe("used");
    // Every command is still one tool call in the settled summary, under the
    // computer and browser icons instead of a terminal.
    expect(countEventSummary(events)).toMatchObject({ toolCalls: 4, messages: 1 });
    expect(summaryIcons(events)).toEqual([SquareMousePointer, Globe]);
    expect(summaryIcons([shell("pwd", { command: "pwd" })])).toEqual([Terminal]);
  });

  it("renders the verb, the app or site and the duration on the row", () => {
    const tool = run("zeros computer open --app Calculator");
    const activity = browserToolActivity(tool)!;
    expect(
      nativeCodexBrowserPresentation(tool, undefined, activity),
    ).toMatchObject({ label: "Opened app", target: "Calculator", trailing: "839ms" });
    const html = renderToStaticMarkup(
      h(
        TooltipProvider,
        null,
        h(NativeBrowserToolRow, {
          tool,
          ctx: { attachmentImagesActive: false } as RendererContext,
          browserActivity: activity,
        }),
      ),
    );
    expect(html).toContain("Opened app");
    expect(html).toContain("Calculator");
    expect(html).toContain("839ms");
    expect(html).not.toContain("lucide-terminal");
    expect(html).not.toContain("zeros computer");
    // A failed command keeps the shared Error treatment.
    const failed = renderToStaticMarkup(
      h(
        TooltipProvider,
        null,
        h(NativeBrowserToolRow, {
          tool: { ...tool, status: "failed" },
          ctx: { attachmentImagesActive: false } as RendererContext,
          browserActivity: { ...activity, status: "failed" },
        }),
      ),
    );
    expect(failed).toContain("Error");
    expect(failed).toContain("text-red-primary");
  });
});
