import { mkdir, readFile, writeFile } from "node:fs/promises";
import { PromotionError, releaseSource, requireCheck } from "./contracts";
import { buildReleaseLedger, previousReleaseLedger, ReleaseLedger, releaseLedgerAsset, verifyPublishedReleaseLedger } from "./release-ledger";

async function main() {
  const source = releaseSource(process.env), mode = process.argv[2];
  requireCheck(mode === "--build" || mode === "--verify", "Usage: release-ledger-cli.ts --build|--verify");
  const file = `release/${releaseLedgerAsset(source.channel)}`;
  if (mode === "--build") {
    const previous = await previousReleaseLedger(source.repository, source.channel, process.env.GH_TOKEN);
    const ledger = buildReleaseLedger(source.channel, previous, { version: process.env.RELEASE_VERSION ?? process.env.VERSION ?? "",
      publishedAt: new Date().toISOString(), sourceSha: source.sourceSha });
    await mkdir("release", { recursive: true });
    await writeFile(file, `${JSON.stringify(ledger, null, 2)}\n`);
    console.log(`Cumulative ${source.channel} release ledger built (${ledger.releases.length} versions).`);
  } else {
    const result = ReleaseLedger.safeParse(JSON.parse(await readFile(file, "utf8")));
    requireCheck(result.success && result.data.channel === source.channel && result.data.releases.at(-1)?.sourceSha === source.sourceSha,
      "Publication ledger does not belong to this channel and source");
    await verifyPublishedReleaseLedger(source.repository, result.data);
    console.log(`Anonymous ${source.channel} release ledger readback verified.`);
  }
}

void main().catch(error => {
  console.error(error instanceof PromotionError ? error.message : "Release ledger publication failed; private diagnostics withheld.");
  process.exitCode = 1;
});
