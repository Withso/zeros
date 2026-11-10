import { run } from "./zeros";

const stdin = async (): Promise<string> => {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += (chunk as Buffer).byteLength;
    // One byte over the CLI's message limit is enough for it to refuse.
    if (bytes > 1024 * 1024 + 1) break;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
};

// A reader that went away (`zeros cloud … | head`) ends the command at once:
// no stack trace and no further requests. Output nobody reads is not a failure.
const readerGone = (error: NodeJS.ErrnoException) => process.exit(error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED" ? 0 : 1);
process.stdout.on("error", readerGone);
process.stderr.on("error", readerGone);

process.exitCode = await run(process.argv.slice(2), {
  env: process.env, stdin,
  stdout: text => { process.stdout.write(text); },
  stderr: text => { process.stderr.write(text); },
});
