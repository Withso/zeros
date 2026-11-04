import { askpass } from "./client";
import { githubAuthenticationMessage } from "./github-failure";

// stdout is Git's private askpass pipe, never a worker log.
try { process.stdout.write(await askpass(process.argv[2] ?? "", process.env.GH_ZEROS_BROKER_SOCKET ?? "") + "\n"); }
catch (error) { process.stderr.write(githubAuthenticationMessage(error) + "\n"); process.exitCode = 1; }
