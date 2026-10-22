import { createInterface } from "node:readline";
import { isDeepStrictEqual } from "node:util";

const send = frame => process.stdout.write(JSON.stringify(frame) + "\n");
const lines = createInterface({ input: process.stdin });
const replies = new Map();
const flagSettings = [];
const option = name => {
  const inline = process.argv.find(arg => arg.startsWith(`${name}=`));
  if (inline !== undefined) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1];
};
lines.on("line", async line => {
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    if (message.request.subtype === "apply_flag_settings") flagSettings.push(message.request.settings);
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
      } else if (frame.fixtureOptions) {
        const actual = { settings: JSON.parse(option("--settings") ?? "{}"), ...(option("--effort") ? { effort: option("--effort") } : {}) };
        if (!isDeepStrictEqual(actual, frame.fixtureOptions)) throw new Error("Unexpected fixture effort options");
      } else if (frame.fixtureFlagSettings) {
        if (!isDeepStrictEqual(flagSettings, frame.fixtureFlagSettings)) throw new Error("Unexpected fixture effort reset");
      } else if (frame.fixtureEnvironment) {
        const { present, absent } = frame.fixtureEnvironment;
        if (present.some(name => !process.env[name]) || absent.some(name => name in process.env)) throw new Error("Unexpected fixture child environment");
      } else send(JSON.parse(JSON.stringify(frame).replaceAll('"@input"', JSON.stringify(message.uuid))));
    }
  }
});
