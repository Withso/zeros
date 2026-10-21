import { createInterface } from "node:readline";

// Offline native-wire peer. It never loads Codex or connects to a model.
const input = createInterface({ input: process.stdin });
const output = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const reply = (id, result) => output({ id, result });
const notify = (method, params) => output({ method, params });
let threadId = "native-chat";
let turnId;
let nextTurn = 0;
let mode;
let nextRequest = 1000;
const pending = new Map();
const ask = (method, params) => new Promise((resolve) => {
  const id = ++nextRequest;
  pending.set(id, resolve);
  output({ id, method, params });
});
const complete = (status = "completed", thread = threadId, turn = turnId) => notify("turn/completed", { threadId: thread, turn: { id: turn, status } });
const text = (value, thread = threadId, turn = turnId) => notify("item/agentMessage/delta", { threadId: thread, turnId: turn, itemId: "answer", delta: value });

input.on("line", async (line) => {
  const frame = JSON.parse(line);
  if (!frame.method) {
    pending.get(frame.id)?.(frame.result ?? frame.error);
    pending.delete(frame.id);
    return;
  }
  const params = frame.params ?? {};
  switch (frame.method) {
    case "initialize":
      reply(frame.id, { userAgent: "offline-fixture" });
      return;
    case "initialized": return;
    case "thread/start":
    case "thread/resume":
      threadId = params.threadId ?? threadId;
      if (params.approvalPolicy !== "never" || params.sandbox !== "danger-full-access") {
        output({ id: frame.id, error: { code: -32602, message: "Expected full VM permissions" } });
        return;
      }
      reply(frame.id, { thread: { id: threadId }, model: params.model ?? "fixture-model" });
      return;
    case "turn/start": {
      turnId = `turn-${++nextTurn}`;
      mode = params.input.map((part) => part.text ?? "").join("");
      if (mode === "crash") { process.exit(23); }
      if (mode === "malformed") { process.stdout.write("invalid-json\n"); return; }
      if (mode === "no-ack") return;
      if (mode === "before-ack") {
        text("early");
        complete();
        reply(frame.id, { turn: { id: turnId, status: "inProgress" } });
        return;
      }
      if (mode === "slow-ack") await new Promise((resolve) => setTimeout(resolve, 75));
      reply(frame.id, { turn: { id: turnId, status: "inProgress" } });
      notify("turn/started", { threadId, turn: { id: turnId, status: "inProgress" } });
      if (mode.startsWith("fixture:")) {
        for (const frame of JSON.parse(mode.slice(8))) {
          const params = { ...frame.params, threadId, turnId };
          if (params.turn) params.turn = { ...params.turn, id: turnId };
          notify(frame.method, params);
        }
        return;
      }
      if (["wait", "slow-ack", "ignore-interrupt"].includes(mode)) { text("working"); return; }
      if (mode === "foreign") {
        text("foreign", "other-chat", "other-turn");
        complete("completed", "other-chat", "other-turn");
        text("stale", threadId, "retired-turn");
        complete("completed", threadId, "retired-turn");
      }
      if (mode === "requests") {
        const replies = [];
        for (const method of ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/tool/requestUserInput", "mcpServer/elicitation/request", "unsupported/request"]) {
          replies.push(await ask(method, { threadId, turnId, itemId: "question", questions: [] }));
        }
        text(JSON.stringify(replies));
      } else {
        text(mode === "model" ? params.model : "hello");
      }
      complete();
      return;
    }
    case "turn/interrupt":
      if (params.threadId !== threadId || params.turnId !== turnId) {
        output({ id: frame.id, error: { code: -32602, message: "Wrong native turn" } });
        return;
      }
      reply(frame.id, {});
      if (mode !== "ignore-interrupt") complete("interrupted");
      return;
    case "turn/steer":
      if (params.threadId !== threadId || params.expectedTurnId !== turnId) {
        output({ id: frame.id, error: { code: -32602, message: "Wrong native turn" } });
        return;
      }
      reply(frame.id, { turnId });
      text(params.input.map((part) => part.text ?? "").join(""));
      return;
    default:
      output({ id: frame.id, error: { code: -32601, message: "Unsupported method" } });
  }
});
