import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createAlphaBuildMetadata, validateAlphaBuildMetadata, validateAlphaProducerProof, waitForAlphaBuild } from "./alpha-build";
import { PromotionError, releaseSource, requireCheck } from "./contracts";
import { jsonClient } from "./io";
const { load } = createRequire(import.meta.url)("js-yaml") as { load(source: string): unknown };

async function readBounded(file: string) {
  const bytes = await readFile(file);
  requireCheck(bytes.length <= 16 * 1024, "Alpha build metadata or producer proof exceeds its bound");
  return JSON.parse(bytes.toString("utf8"));
}
async function main() {
  const [mode, kind] = process.argv.slice(2), env = process.env;
  const source = releaseSource(env), json = jsonClient();
  const read = (route: string) => json(`https://api.github.com/repos/${source.repository}${route}`, { headers: {
    authorization: `Bearer ${env.GH_TOKEN}`, accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
  } });
  if (mode === "--record" && kind === undefined) {
    const metadata = createAlphaBuildMetadata(env);
    await writeFile("release/alpha-build-metadata.json", `${JSON.stringify(metadata, null, 2)}\n`);
  } else if (mode === "--wait" && (kind === "desktop" || kind === "runtime")) {
    console.log(`Waiting up to 45 minutes for this run's exact-source Alpha ${kind} producer.`);
    const proof = await waitForAlphaBuild(kind, env, read);
    await mkdir(".context/release", { recursive: true, mode: 0o700 });
    await writeFile(`.context/release/alpha-${kind}-producer.json`, `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 });
    requireCheck(env.GITHUB_OUTPUT, "Alpha build readiness requires an artifact output destination");
    await appendFile(env.GITHUB_OUTPUT, `artifact_id=${proof.artifactId}\n`);
    console.log(`Alpha ${kind} producer and same-run artifact verified.`);
  } else if (mode === "--verify-producer" && (kind === "desktop" || kind === "runtime")) {
    const proof = await validateAlphaProducerProof(await readBounded(`.context/release/alpha-${kind}-producer.json`), env, read);
    requireCheck(proof.kind === kind, "Alpha build producer proof belongs to another artifact kind");
    console.log(`Alpha ${kind} producer, immutable artifact and current parent attempt revalidated after download.`);
  } else if (mode === "--verify-metadata" && kind === undefined) {
    const metadata = await validateAlphaBuildMetadata(await readBounded("release/alpha-build-metadata.json"),
      await readBounded(".context/release/alpha-desktop-producer.json"), env, read);
    const feedBytes = await readFile("release/alpha-mac.yml");
    requireCheck(feedBytes.length <= 64 * 1024, "Alpha updater feed exceeds its bound");
    const feed = load(feedBytes.toString("utf8")) as { version?: unknown } | null;
    requireCheck(feed?.version === metadata.releaseVersion, "Alpha feed version differs from its signed-build metadata");
    requireCheck(env.GITHUB_OUTPUT, "Alpha metadata verification requires a publication output destination");
    await appendFile(env.GITHUB_OUTPUT, `version=${metadata.releaseVersion}\ncloud_enabled=${metadata.cloudEnabled}\n`);
    console.log("Alpha signed-build source, producing attempt, version and baked cloud capability verified.");
  } else throw new PromotionError("Usage: alpha-build-cli.ts --record|--wait desktop|--wait runtime|--verify-producer desktop|--verify-producer runtime|--verify-metadata");
}

void main().catch(error => {
  console.error(error instanceof PromotionError ? error.message : "Alpha build handoff failed; publication refused.");
  process.exitCode = 1;
});
