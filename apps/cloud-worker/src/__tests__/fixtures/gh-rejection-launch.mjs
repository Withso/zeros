import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

const spawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => {
  if (command !== "/usr/bin/gh" || args.join(" ") !== "pr create") throw new Error("Unexpected gh fixture command.");
  return spawn(process.execPath, ["-e", `
    if (process.env.GH_TOKEN !== 'fixture-rejected-user') process.exit(2);
    process.stdout.write('fixture-write-completed\\n');
    process.stderr.write('gh: Bad credentials (HTTP 401)\\n');
    process.exitCode = 1;
  `], options);
};
syncBuiltinESMExports();
