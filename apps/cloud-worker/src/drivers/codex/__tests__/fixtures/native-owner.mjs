import { createInterface } from "node:readline";

const send = frame => process.stdout.write(`${JSON.stringify(frame)}\n`);
const reply = (id, result) => send({ id, result });
const notify = (method, params) => send({ method, params });
const complete = id => notify("turn/completed", { threadId: "thread", turn: { id, status: "completed" } });
const pending = new Map();
let turn = 0;
createInterface({ input: process.stdin }).on("line", line => {
  const frame = JSON.parse(line);
  if (!frame.method) {
    pending.get(frame.id)?.(frame.result);
    pending.delete(frame.id);
    return;
  }
  if (frame.method === "initialized") return;
  if (frame.method === "initialize") return reply(frame.id, {});
  if (frame.method === "thread/start") return reply(frame.id, { thread: { id: "thread" } });
  if (frame.method !== "turn/start") return reply(frame.id, {});
  const current = `turn-${++turn}`;
  if (turn === 1) {
    reply(frame.id, { turn: { id: current, status: "inProgress" } });
    complete(current);
    return;
  }
  const spec = JSON.parse(frame.params.input[0].text);
  const ack = () => reply(frame.id, { turn: { id: current, status: "inProgress" } });
  if (spec.afterAck) ack();
  pending.set("native-request", result => {
    if (spec.ackOnResponse) ack();
    notify("item/agentMessage/delta", { threadId: "thread", turnId: current, itemId: "answer", delta: JSON.stringify(result) });
    complete(current);
  });
  send({ id: "native-request", method: spec.kind === "question" ? "item/tool/requestUserInput" : "item/commandExecution/requestApproval",
    params: { threadId: "thread", turnId: spec.foreign ? "turn-1" : current, itemId: "native-input",
      command: "fixture action", questions: [{ id: "route", question: "Route?", options: [{ label: "A" }] }] } });
  if (!spec.afterAck && !spec.ackOnResponse && !spec.missingAck) ack();
});
