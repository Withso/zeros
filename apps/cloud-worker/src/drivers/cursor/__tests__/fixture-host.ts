import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { ContentBlock } from "@zeros/protocol/agent-events";

export const text = (value: string): ContentBlock[] => [{ type: "text", text: value }];
export const prompt = (fixture: object): ContentBlock[] => text(JSON.stringify(fixture));
export async function fixtureHost() {
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  const directory = await mkdtemp(join(root, ".worker-build-cursor-"));
  const path = join(directory, "cursor-host.mjs");
  await build({ entryPoints: [fileURLToPath(new URL("../host-entry.ts", import.meta.url))], outfile: path,
    alias: { "@cursor/sdk": fileURLToPath(new URL("./fixtures/sdk.ts", import.meta.url)) },
    platform: "node", target: "node24", format: "esm", bundle: true, logLevel: "silent" });
  return { path, dispose: () => rm(directory, { recursive: true, force: true }) };
}
