import { runGh } from "./client";

try { process.exitCode = await runGh(process.argv.slice(2)); }
catch { process.stderr.write("GitHub authentication is unavailable.\n"); process.exitCode = 1; }
