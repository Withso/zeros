import { describe, expect, it } from "vitest";
import { LocalOrchestrationError, parseLocalCall } from "@zeros/protocol/local-orchestration";
import { localCliHelp, parseLocalCliArgs } from "../cli-parse";

describe("Local CLI argv", () => {
  it.each([
    [["whoami"], "whoami", {}],
    [["models", "--agent", "codex"], "models", { agent: "codex" }],
    [["repo", "list"], "repo.list", {}],
    [["workspace", "list", "--repo", "repo-1"], "workspace.list", { repo: "repo-1" }],
    [["workspace", "status", "folder:project-1"], "workspace.status", { workspace: "folder:project-1" }],
    [["workspace", "create", "--repo", "current", "--base", "HEAD", "--name", "parser"], "workspace.create", { repo: "current", base: "HEAD", name: "parser" }],
    [["chat", "list", "--workspace", "ws_1", "--tree"], "chat.list", { workspace: "ws_1", tree: true }],
    [["chat", "create", "--message", "Read this"], "chat.create", { message: "Read this" }],
    [["chat", "status", "chat-1"], "chat.status", { chat: "chat-1" }],
    [["chat", "cancel", "chat-1"], "chat.cancel", { chat: "chat-1" }],
    [["chat", "unfollow", "chat-1"], "chat.unfollow", { chat: "chat-1" }],
    [["chat", "wait", "a", "b", "--any", "--until", "done", "--timeout", "90"], "chat.wait", { targets: [{ chat: "a" }, { chat: "b" }], any: true, until: "done", timeoutMs: 90_000 }],
    [["chat", "messages", "a", "--summary", "--after", "cursor", "--limit", "50"], "chat.messages", { chat: "a", view: "summary", after: "cursor", limit: 50 }],
    [["chat", "follow", "a", "--events", "done,question,permission"], "chat.follow", { chat: "a", events: ["done", "question", "permission"] }],
    [["message", "send", "a", "--message", "Hello", "--steer", "--notify"], "message.send", { chat: "a", message: "Hello", delivery: "steer", notify: true }],
    [["card", "list"], "card.list", {}],
    [["card", "list", "a"], "card.list", { chat: "a" }],
    [["card", "answer", "c", "--deny"], "card.answer", { card: "c", deny: true }],
    [["link", "folder:project-1"], "link", { target: "folder:project-1" }],
  ] as const)("parses %j into a protocol call", (argv, command, args) => {
    const parsed = parseLocalCliArgs(argv);
    expect(parsed).toEqual({ command, args, json: false });
    expect(parseLocalCall({ command: parsed.command, args: parsed.args }).ok).toBe(true);
  });

  it("keeps all chat settings, including an explicit false Fast, in the right shape", () => {
    const settings = ["--agent", "codex", "--model", "gpt-6.1-sol", "--effort", "max", "--no-fast", "--mode", "auto-edit", "--title", "Parser fix", "--notify", "--message", "Brief"];
    const chat = { agent: "codex", model: "gpt-6.1-sol", effort: "max", fast: false, mode: "auto-edit", title: "Parser fix", notify: true, message: "Brief" };
    expect(parseLocalCliArgs(["chat", "create", "--workspace", "ws_1", ...settings]).args)
      .toEqual({ workspace: "ws_1", ...chat });
    expect(parseLocalCliArgs(["workspace", "create", "--repo", "current", ...settings]).args)
      .toEqual({ repo: "current", chat });
    expect(parseLocalCliArgs(["chat", "create", "--fast", "--message", "Brief"]).args.fast).toBe(true);
  });

  it("leaves file input outside wire args for the CLI to resolve and tools to reject", () => {
    expect(parseLocalCliArgs(["chat", "create", "--message-file", "-"])).toEqual({
      command: "chat.create", args: {}, json: false, messageFile: "-",
    });
    expect(parseLocalCliArgs(["workspace", "create", "--repo", "current", "--title", "Review", "--message-file", "a b.md"]))
      .toEqual({ command: "workspace.create", args: { repo: "current", chat: { title: "Review" } }, json: false, messageFile: "a b.md" });
    expect(parseLocalCliArgs(["message", "send", "a", "--new-turn", "--message-file", "brief.md"]).args)
      .toEqual({ chat: "a", delivery: "new-turn" });
  });

  it("accepts global options anywhere, equals values, and channel-specific links verbatim", () => {
    const link = "zeros-beta://chat/chat-1";
    const argv = ["--json", "chat", "wait", link, "--turn=turn-1", "--request-id", "retry:1", "--timeout=0.25"];
    expect(parseLocalCliArgs(argv)).toEqual({ command: "chat.wait", json: true, requestId: "retry:1", args: { targets: [{ chat: link, turn: "turn-1" }], timeoutMs: 250 } });
    expect(argv).toEqual(["--json", "chat", "wait", link, "--turn=turn-1", "--request-id", "retry:1", "--timeout=0.25"]);
    expect(parseLocalCliArgs(["chat", "status", "--", "-literal-id"]).args).toEqual({ chat: "-literal-id" });
    expect(parseLocalCliArgs(["message", "send", "a", "--message=--literal"]).args.message).toBe("--literal");
  });

  it("parses every card answer shape without changing question option ids", () => {
    const answers = [{ questionId: "q1", selectedOptionIds: ["o2"], freeText: "Context" }];
    expect(parseLocalCliArgs(["card", "answer", "c", "--answers", JSON.stringify(answers)]).args).toEqual({ card: "c", answers });
    expect(parseLocalCliArgs(["card", "answer", "c", "--option", "allow-once"]).args).toEqual({ card: "c", option: "allow-once" });
    expect(parseLocalCliArgs(["card", "answer", "c", "--text", "Proceed"]).args).toEqual({ card: "c", text: "Proceed" });
  });

  it("supports the remaining transcript and delivery options", () => {
    expect(parseLocalCliArgs(["chat", "messages", "a", "--last", "--include-tools", "--turn", "t"]).args)
      .toEqual({ chat: "a", view: "last", includeTools: true, turn: "t" });
    expect(parseLocalCliArgs(["message", "send", "a", "--new-turn", "--message", "Follow-up"]).args)
      .toEqual({ chat: "a", delivery: "new-turn", message: "Follow-up" });
  });

  it("converts fractional seconds without floating-point rejection", () => {
    expect(parseLocalCliArgs(["chat", "wait", "a", "--timeout", "1.001"]).args.timeoutMs).toBe(1001);
  });

  it("shows root, group, and leaf help without requiring operands or a message", () => {
    expect(parseLocalCliArgs([]).help).toContain("zeros local");
    expect(parseLocalCliArgs(["chat", "--help"]).help).toContain("chat wait");
    expect(parseLocalCliArgs(["chat", "create", "-h"]).help).toContain("--message-file");
    expect(parseLocalCliArgs(["chat", "create", "-h"]).command).toBe("chat.create");
    expect(localCliHelp("chat.wait")).toContain("--until");
  });

  it.each([
    [["wat"], "Unknown command"],
    [["chat", "wat"], "Unknown command"],
    [["chat"], "Choose a chat command"],
    [["whoami", "extra"], "Unexpected argument"],
    [["chat", "status"], "requires <chat>"],
    [["whoami", "--bogus"], "Unknown option --bogus"],
    [["whoami", "--model", "x"], "--model is not valid"],
    [["models", "--agent"], "--agent requires a value"],
    [["models", "--agent", "--json"], "--agent requires a value"],
    [["models", "--agent", "a", "--agent", "b"], "--agent was supplied more than once"],
    [["whoami", "--json=false"], "--json does not take a value"],
    [["workspace", "create"], "requires --repo"],
    [["chat", "create"], "requires --message or --message-file"],
    [["message", "send", "a"], "requires --message or --message-file"],
    [["chat", "create", "--message", "a", "--message-file", "b"], "Choose only one of --message, --message-file"],
    [["chat", "create", "--message", "a", "--fast", "--no-fast"], "Choose only one of --fast, --no-fast"],
    [["message", "send", "a", "--message", "b", "--steer", "--new-turn"], "Choose only one of --steer, --new-turn"],
    [["chat", "messages", "a", "--summary", "--last"], "Choose only one of --summary, --last"],
    [["chat", "wait", "a", "b", "--turn", "t"], "--turn requires exactly one chat"],
    [["chat", "wait", "a", "--timeout", "NaN"], "--timeout must be"],
    [["chat", "wait", "a", "--timeout=Infinity"], "--timeout must be"],
    [["chat", "wait", "a", "--timeout=-1"], "--timeout must be"],
    [["chat", "messages", "a", "--limit", "1.5"], "--limit must be"],
    [["chat", "messages", "a", "--limit", "101"], "limit"],
    [["chat", "follow", "a", "--events", "unknown"], "events"],
    [["card", "answer", "c"], "requires one of"],
    [["card", "answer", "c", "--option", "o", "--deny"], "Choose only one of"],
    [["card", "answer", "c", "--answers", "not json"], "--answers must be valid JSON"],
    [["card", "answer", "c", "--answers", "[]"], "answers"],
    [["whoami", "--request-id", "has spaces"], "requestId"],
  ] as const)("rejects invalid argv %j with a useful usage error", (argv, message) => {
    expect(() => parseLocalCliArgs(argv)).toThrow(message);
    try { parseLocalCliArgs(argv); } catch (error) {
      expect(error).toBeInstanceOf(LocalOrchestrationError);
      expect((error as LocalOrchestrationError).code).toBe("USAGE");
    }
  });
});
