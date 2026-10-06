import { copyFileSync } from "node:fs";

// The bootstrap command and runtime bundle use these exact reviewed bytes.
// Resolve from the built module so Docker and local builds have the same asset.
copyFileSync(
  new URL("../src/cloud-workspaces/runtime-update-adapter.py", import.meta.url),
  new URL("./cloud-workspaces/runtime-update-adapter.py", import.meta.url),
);
