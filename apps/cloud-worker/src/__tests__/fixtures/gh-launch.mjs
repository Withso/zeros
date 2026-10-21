// Offline package smoke: exercise the real wrapper and broker, replacing only
// /usr/bin/gh (a VM prerequisite) with a child that verifies its private env.
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

const spawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => {
  if (command !== "/usr/bin/gh" || args.length !== 1 || args[0] !== "--version")
    throw new Error("Unexpected packaged gh launch.");
  return spawn(process.execPath, ["-e", `
    const forbidden = ['NODE_OPTIONS', 'ZEROS_WORKER_TOKEN', 'CURSOR_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'];
    if (process.env.GH_TOKEN !== 'fixture-package-github' || forbidden.some(name => name in process.env)) process.exit(1);
    process.stdout.write('gh version fixture\\n');
  `], options);
};
syncBuiltinESMExports();
