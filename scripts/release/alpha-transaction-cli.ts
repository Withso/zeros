import { PromotionError, releaseSource, requireCheck } from "./contracts";
import { githubClient } from "./github";
import { command } from "./io";

async function main() {
  const source = releaseSource(process.env);
  requireCheck((await command("git", ["rev-parse", "HEAD"])).trim() === source.sourceSha, "Alpha transaction checkout differs from the event SHA");
  await githubClient(source, process.env).assertAlphaTransaction();
  console.log("Alpha parent, exact-source CI, admission, live frontiers and publication order verified inside the destination lock.");
}

void main().catch(error => {
  console.error(error instanceof PromotionError ? error.message : "Alpha transaction entry failed; provider and feed mutation refused.");
  process.exitCode = 1;
});
