import { gitCredential } from "./broker";
import { githubAuthenticationMessage } from "./github-failure";

try {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 16_384) throw new Error("Invalid credential input.");
  }
  // This is Git's private helper pipe, never a worker log.
  process.stdout.write(await gitCredential(process.argv[2] ?? "", input, process.env.GH_ZEROS_BROKER_SOCKET ?? ""));
} catch (error) { if (process.argv[2] === "get") process.stdout.write("quit=true\n\n"); process.stderr.write(githubAuthenticationMessage(error) + "\n"); process.exitCode = 1; }
