// Synthetic package graphs exercise private SOURCE fixture assembly only.
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stageSourceFixtureDependencies } from "../cloud-workspace-validation/cloud-agent-e2e/source-fixture-dependencies";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function setup() {
  const parent = path.join(process.cwd(), ".context/agents-fix/scratch/W5/p3");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, "source-fixture-dependencies-")); temporary.push(root);
  const source = path.join(root, "source"), destination = path.join(root, "private");
  const owner = path.join(source, "apps/control-plane");
  await mkdir(owner, { recursive: true }); await mkdir(destination);
  await writeFile(path.join(owner, "package.json"), JSON.stringify({ name: "fixture-cp", version: "1" }));
  async function pkg(name: string, version: string, code: string, dependencies: Record<string, string> = {}) {
    const physical = path.join(source, "node_modules/.store", `${name}-${version}`, "node_modules", name);
    await mkdir(physical, { recursive: true });
    await writeFile(path.join(physical, "package.json"), JSON.stringify({ name, version, main: "index.cjs", dependencies }));
    await writeFile(path.join(physical, "index.cjs"), code);
    return physical;
  }
  async function link(name: string, owner: string, physical: string) {
    const alias = path.join(owner, "node_modules", name); await mkdir(path.dirname(alias), { recursive: true });
    await symlink(path.relative(path.dirname(alias), physical), alias);
  }
  const codec = await pkg("pg-connection-string", "1", "module.exports = { fixture: 'connection' };");
  const pg = await pkg("pg", "1", "module.exports = require('pg-connection-string');", { "pg-connection-string": "1" });
  const zod = await pkg("zod", "3", "module.exports = { fixture: 'zod3' };");
  const hono = await pkg("hono", "1", "module.exports = { routePath: () => 'fixture-route' };");
  await link("pg-connection-string", pg, codec); await link("pg", owner, pg); await link("zod", owner, zod); await link("hono", owner, hono);
  return { source, destination, owner, root, pkg, link, pg, zod };
}
describe("private SOURCE fixture CP dependency closure", () => {
  it("keeps the CP's own pg/transitive and Zod3 packages resolvable inside the private copy", async () => {
    const f = await setup(); const before = await readFile(path.join(f.zod, "index.cjs"));
    const result = await stageSourceFixtureDependencies(f.source, f.destination);
    const require = createRequire(path.join(f.destination, "apps/control-plane/package.json"));
    expect(require("pg")).toEqual({ fixture: "connection" });
    expect(require("zod")).toEqual({ fixture: "zod3" });
    expect(require.resolve("pg").startsWith(f.destination + path.sep)).toBe(true);
    expect(require.resolve("zod").startsWith(f.destination + path.sep)).toBe(true);
    expect(result.packageCount).toBeGreaterThan(0);
    expect(await readFile(path.join(f.zod, "index.cjs"))).toEqual(before);
  });
  it("also copies the CP request-timing Hono route dependency reached through its schema/DB imports", async () => {
    const f = await setup(); await stageSourceFixtureDependencies(f.source, f.destination);
    const require = createRequire(path.join(f.destination, "apps/control-plane/package.json"));
    expect(require("hono").routePath()).toBe("fixture-route");
    expect(require.resolve("hono").startsWith(f.destination + path.sep)).toBe(true);
  });
  it("preserves separate transitive versions instead of replacing another owner's dependency", async () => {
    const f = await setup();
    const other = await f.pkg("pg-connection-string", "2", "module.exports = { fixture: 'other' };");
    const dependent = await f.pkg("zod", "other", "module.exports = require('pg-connection-string');", { "pg-connection-string": "2" });
    await f.link("pg-connection-string", dependent, other);
    await rm(path.join(f.owner, "node_modules/zod")); await f.link("zod", f.owner, dependent);
    await stageSourceFixtureDependencies(f.source, f.destination);
    const require = createRequire(path.join(f.destination, "apps/control-plane/package.json"));
    expect(require("pg")).toEqual({ fixture: "connection" }); expect(require("zod")).toEqual({ fixture: "other" });
  });
  it.each(["zod", "hono"])("refuses a required missing %s package rather than completing an empty closure", async name => {
    const f = await setup(); await rm(path.join(f.owner, "node_modules", name));
    await expect(stageSourceFixtureDependencies(f.source, f.destination)).rejects.toThrow("fixture_contract_invalid");
  });
  it("refuses source package links outside the supplied source tree", async () => {
    const f = await setup(); const outside = path.join(f.root, "outside"); await mkdir(outside);
    await writeFile(path.join(outside, "package.json"), JSON.stringify({ name: "pg", version: "1" }));
    await rm(path.join(f.owner, "node_modules/pg")); await f.link("pg", f.owner, outside);
    await expect(stageSourceFixtureDependencies(f.source, f.destination)).rejects.toThrow("fixture_contract_invalid");
  });
  it("refuses a destination parent link escaping the private copy before writes", async () => {
    const f = await setup(); await symlink(path.join(f.source, "apps"), path.join(f.destination, "apps"));
    await expect(stageSourceFixtureDependencies(f.source, f.destination)).rejects.toThrow("fixture_contract_invalid");
    expect(await readFile(path.join(f.owner, "package.json"), "utf8")).toBe(JSON.stringify({ name: "fixture-cp", version: "1" }));
  });
});
