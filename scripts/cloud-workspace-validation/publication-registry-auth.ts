import path from "node:path";
import {
  stagePublicationRegistryAuth,
  restorePublicationRegistryAuth,
} from "./lib/publication-registry-auth";

async function main() {
  const operation = process.argv[2];
  const dockerConfigDirectory = process.env.DOCKER_CONFIG;
  if (operation === "restore" && !dockerConfigDirectory) return;
  if (!dockerConfigDirectory || !["stage", "restore"].includes(operation))
    throw new Error("Registry credential handoff configuration missing");
  const options = {
    dockerConfigDirectory,
    stateDirectory: path.dirname(dockerConfigDirectory),
  };
  if (operation === "stage") await stagePublicationRegistryAuth(options);
  else await restorePublicationRegistryAuth(options);
}
main().catch(() => {
  console.error("Publication registry credential handoff failed.");
  process.exitCode = 1;
});
