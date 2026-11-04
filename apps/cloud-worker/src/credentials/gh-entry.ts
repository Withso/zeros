import { runGh } from "./client";
import { githubAuthenticationMessage } from "./github-failure";

try { process.exitCode = await runGh(process.argv.slice(2)); }
catch (error) { process.stderr.write(githubAuthenticationMessage(error) + "\n"); process.exitCode = 1; }
