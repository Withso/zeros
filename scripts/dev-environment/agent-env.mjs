#!/usr/bin/env node
// Operator fixture credentials (.env.agent) stay out of new workspaces.
// Development agents reach providers through the Zeros Internal MCP; only an
// operator's explicit import may place .env.agent into a shared checkout.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseAgentEnv } from "../agent-env-check.mjs";
import { systemEnvironment, writePrivateFile } from "./state.mjs";

export const AGENT_ENV = ".env.agent";
// Kept in the checkout's own Git directory, which no copy rule can populate,
// so a receipt proves an explicit import into this checkout.
const RECEIPT = "zeros-agent-env-import";
const MAX_BYTES = 256 * 1024;
const MCP_GUIDE = "Development agents reach providers through the Zeros Internal MCP (apps/control-plane/INTERNAL-OPS.md)";
const IMPORT_COMMAND = "node scripts/dev-environment/agent-env.mjs import <file>";
const SETUP_COMMAND = "sh scripts/dev-environment/hook.sh setup";

const git = (root, args) =>
  execFileSync("git", args, { cwd: root, env: systemEnvironment(), encoding: "utf8", stdio: "pipe" }).trimEnd();
const receiptPath = root => path.resolve(root, git(root, ["rev-parse", "--git-dir"]), RECEIPT);

/** A linked worktree or the checkout Conductor created for this workspace. */
export function isNewWorkspace(root, env = process.env) {
  if (fs.lstatSync(path.join(root, ".git"), { throwIfNoEntry: false })?.isFile()) return true;
  try { return Boolean(env.CONDUCTOR_WORKSPACE_PATH) && fs.realpathSync(env.CONDUCTOR_WORKSPACE_PATH) === fs.realpathSync(root); }
  catch { return false; }
}

export function assertNoCopiedAgentEnv(root, env = process.env) {
  if (!fs.lstatSync(path.join(root, AGENT_ENV), { throwIfNoEntry: false }) || !isNewWorkspace(root, env)) return;
  if (fs.lstatSync(receiptPath(root), { throwIfNoEntry: false })?.isFile()) return;
  throw new Error([
    `This new workspace holds a copied ${AGENT_ENV}, so setup stopped before installing dependencies.`,
    `${MCP_GUIDE}. To continue without it, run:`,
    `  rm ${AGENT_ENV} && ${SETUP_COMMAND}`,
    `Operators who need fixture credentials in this workspace run instead:`,
    `  node scripts/dev-environment/agent-env.mjs import ${AGENT_ENV} && ${SETUP_COMMAND}`,
    `Then remove ${AGENT_ENV} from the copy settings that delivered it (Conductor files to copy, .worktreeinclude).`,
  ].join("\n"));
}

export function importAgentEnv({ root, source, replace = false }) {
  const checkout = fs.realpathSync(root);
  if (fs.realpathSync(git(checkout, ["rev-parse", "--show-toplevel"])) !== checkout) throw new Error("Run the import from the repository root");
  try { git(checkout, ["check-ignore", "-q", AGENT_ENV]); }
  catch { throw new Error(`${AGENT_ENV} is not ignored by Git in this checkout; nothing was written`); }
  const destination = path.join(checkout, AGENT_ENV);
  let fd;
  try { fd = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK); }
  catch { throw new Error("The import source is not readable"); }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("The import source must be a regular file under 256 KiB");
    const existing = fs.lstatSync(destination, { throwIfNoEntry: false });
    // Importing the checkout's own file adopts it in place: an operator keeping
    // a copy that setup refused.
    const inPlace = Boolean(existing?.isFile() && existing.dev === stat.dev && existing.ino === stat.ino);
    if (existing && !inPlace && !replace) throw new Error(`${AGENT_ENV} already exists; pass --replace to overwrite it`);
    const text = fs.readFileSync(fd, "utf8");
    const parsed = parseAgentEnv(text);
    if (parsed.malformedLines.length) throw new Error(`Malformed line(s) ${parsed.malformedLines.join(", ")}; nothing was written`);
    if (inPlace) {
      if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error(`${AGENT_ENV} must be owned by your user`);
      fs.fchmodSync(fd, 0o600);
    }
    else writePrivateFile(destination, text);
    writePrivateFile(receiptPath(checkout), `${new Date().toISOString()}\n`);
    return { keys: parsed.values.size };
  } finally { fs.closeSync(fd); }
}

async function main() {
  const args = process.argv.slice(2);
  const replace = args.includes("--replace"), rest = args.filter(arg => arg !== "--replace");
  if (rest[0] !== "import" || rest.length !== 2) throw new Error(`usage: ${IMPORT_COMMAND} [--replace]`);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const { keys } = importAgentEnv({ root, source: path.resolve(rest[1]), replace });
  console.log(`[zeros-dev] Imported ${keys} keys into ${AGENT_ENV} with mode 0600. ${MCP_GUIDE}.`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch (error) {
    // Never reflect raw filesystem errors, which can carry paths or contents.
    const message = error instanceof Error && !error.code ? error.message : "The import could not complete; check file ownership and permissions";
    console.error(`[zeros-dev] ${message}`); process.exitCode = 1;
  }
}
