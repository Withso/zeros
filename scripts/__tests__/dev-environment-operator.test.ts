import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { packDevOperator, unpackDevOperator } from "../dev-environment/operator-artifact.mjs";
it("runs the recorded cleanup dependency after the original checkout has been removed", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dev-operator-portable-"));
  const root = path.join(directory, "checkout"), base = path.join(root, "apps/control-plane"), destination = path.join(directory, "restore");
  try {
    fs.mkdirSync(path.join(base, "dist"), { recursive: true }); fs.mkdirSync(destination);
    fs.mkdirSync(path.join(base, "node_modules/test-dependency"), { recursive: true });
    fs.writeFileSync(path.join(base, "node_modules/test-dependency/package.json"), JSON.stringify({ name: "test-dependency", main: "index.js" }));
    fs.writeFileSync(path.join(base, "node_modules/test-dependency/index.js"), "module.exports = 42;");
    fs.writeFileSync(path.join(base, "package.json"), JSON.stringify({ type: "module" }));
    fs.writeFileSync(path.join(base, "dist/db.js"), 'import value from "test-dependency"; export default value;');
    fs.writeFileSync(path.join(base, "dist/migrate.js"), 'export default true;');
    const artifact = packDevOperator(root);
    fs.rmSync(root, { recursive: true, force: true });
    unpackDevOperator(artifact.body, artifact.digest, destination, root);
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", 'import value from "./apps/control-plane/dist/db.js"; console.log(value)'], { cwd: destination, encoding: "utf8", stdio: "pipe" });
    expect(output.trim()).toBe("42");
    expect(fs.existsSync(path.join(destination, "apps/control-plane/node_modules"))).toBe(false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
