import { mkdir, open, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { acquireCloudNativeHistory } from "../../cloud-native-history";

// Use history's HOME module instance so the original brand is shared on Node 22.
const { createCloudNativeHome } = createRequire(import.meta.url)("../../cloud-native-home") as typeof import("../../cloud-native-home");

const dataRoot = process.argv[2]!, root = process.argv[3]!;
const nativeHome = await createCloudNativeHome({ dataRoot, conversationId: "abrupt", provider: "cursor", executionId: "crashed" });
const held = await acquireCloudNativeHistory({ root, conversationId: "abrupt", provider: "cursor",
  uid: process.geteuid!(), gid: process.getegid!(), nativeHome });
const home = path.join(nativeHome.paths.cursorHome, "zeros-store");
await mkdir(home, { mode: 0o700 });
await held.bind(home);
await writeFile(path.join(nativeHome.paths.cursorHome, "auth.json"), "synthetic orphan auth");
const file = await open(path.join(home, "checkpoints.ndjson"), "wx", 0o600);
await file.writeFile("persisted before abrupt exit\n");
await file.sync();
await file.close();
Object.assign(globalThis, { heldHistory: held });
process.stdout.write("history-ready\n");
setInterval(() => {}, 1000);
