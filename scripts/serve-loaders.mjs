#!/usr/bin/env node
/**
 * Start the Loaders showcase static server with clear preview instructions.
 *
 * In remote development environments, localhost:8080 may need explicit port
 * forwarding. For a zero-setup preview, open the artifact directly from the
 * file tree in a browser.
 */
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT || "8080");

function probe(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "0.0.0.0");
  });
}

async function main() {
  const free = await probe(PORT);
  if (!free) {
    console.error(
      `Port ${PORT} is already in use (showcase may already be running).`,
    );
    console.error(
      `Try: http://localhost:${PORT}/styles/Artifacts/loaders-preview.html`,
    );
    process.exit(1);
  }

  const previewPath = path.join(ROOT, "styles/Artifacts/loaders-preview.html");

  console.log("");
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Zeros Loaders Showcase");
  console.log("═══════════════════════════════════════════════════════════");
  console.log("");
  console.log("  OPTION A — no server (recommended for remote development):");
  console.log(`    Open this file in your browser:`);
  console.log(`    ${previewPath}`);
  console.log("");
  console.log("  OPTION B — local HTTP server:");
  console.log(
    `    http://localhost:${PORT}/styles/Artifacts/loaders-preview.html`,
  );
  console.log("");
  console.log("  If needed, forward port", PORT, "from your development tool.");
  console.log("");
  console.log("  OPTION C — via Vite dev server (port 5193):");
  console.log(
    "    pnpm dev   then  http://localhost:5193/styles/Artifacts/loaders-preview.html",
  );
  console.log("");
  console.log("═══════════════════════════════════════════════════════════");
  console.log("");

  const child = spawn(
    "python3",
    [
      "-m",
      "http.server",
      String(PORT),
      "--bind",
      "0.0.0.0",
      "--directory",
      ROOT,
    ],
    {
      cwd: ROOT,
      stdio: "inherit",
      env: process.env,
    },
  );

  child.on("exit", (code) => process.exit(code ?? 0));
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
