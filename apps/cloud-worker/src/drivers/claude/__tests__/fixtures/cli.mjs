import { createInterface } from "node:readline";

const send = frame => process.stdout.write(JSON.stringify(frame) + "\n");
const lines = createInterface({ input: process.stdin });
const replies = new Map();
lines.on("line", async line => {
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
  } else if (message.type === "control_response") {
    replies.get(message.response.request_id)?.(message.response);
    replies.delete(message.response.request_id);
  } else if (message.type === "user") {
    const content = message.message.content;
    const text = typeof content === "string" ? content : content.find(block => block.type === "text")?.text;
    if (!text?.startsWith("fixture:")) throw new Error("Unexpected fixture input");
    for (const frame of JSON.parse(text.slice(8))) {
      if (frame.fixtureControl) {
        const request_id = `fixture-${replies.size}-${frame.fixtureControl.subtype}`;
        const reply = new Promise(resolve => replies.set(request_id, resolve));
        send({ type: "control_request", request_id, request: frame.fixtureControl });
        const response = await reply;
        if (response.subtype !== (frame.expectedSubtype ?? "success") || (frame.field && response.response[frame.field] !== frame.expected)) throw new Error("Unexpected fixture control reply");
      } else if (frame.fixtureEnvironment) {
        const { present, absent } = frame.fixtureEnvironment;
        if (present.some(name => !process.env[name]) || absent.some(name => name in process.env)) throw new Error("Unexpected fixture child environment");
      } else send(JSON.parse(JSON.stringify(frame).replaceAll('"@input"', JSON.stringify(message.uuid))));
    }
  }
});
