#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createShowcaseServer } from "./showcase-server.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../styles/Artifacts");
const port = Number(process.env.PORT || "8080");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid showcase port");
const server = createShowcaseServer(root);
server.on("error", () => { console.error("Unable to start the showcase server; check the port."); process.exitCode = 1; });
server.listen(port, "127.0.0.1", () => {
  console.log(`Loaders showcase: http://127.0.0.1:${port}/styles/Artifacts/loaders-preview.html`);
  console.log("Forward this loopback port through your development tool if needed.");
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close());
