import { createInterface } from "node:readline";
import { openCompleteCheckpointJournal } from "../../cloud-complete-checkpoint-journal";

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let journal: ReturnType<typeof openCompleteCheckpointJournal> | undefined;
for await (const line of lines) {
  const request = JSON.parse(line);
  if (request.action === "open") {
    journal = openCompleteCheckpointJournal({ directory: request.directory, source: request.source, mode: "open" });
    process.stdout.write('{"ready":true}\n');
  } else if (request.action === "write" && journal) {
    const written = await journal.write(request.revision, request.state);
    process.stdout.write(`${JSON.stringify({ written })}\n`);
  } else if (request.action === "close") {
    journal?.close(); lines.close(); break;
  } else throw new Error("unknown test command");
}
journal?.close();
