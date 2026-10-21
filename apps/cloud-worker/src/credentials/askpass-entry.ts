import { askpass } from "./client";

// stdout is Git's private askpass pipe, never a worker log.
try { process.stdout.write(await askpass(process.argv[2] ?? "", process.env.GH_ZEROS_BROKER_SOCKET ?? "") + "\n"); }
catch { process.stderr.write("GitHub authentication is unavailable.\n"); process.exitCode = 1; }
