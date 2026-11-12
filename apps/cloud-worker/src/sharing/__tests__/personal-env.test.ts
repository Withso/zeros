import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { PersonalEnvironments } from "../personal-env";

const CONTEXT = "66666666-6666-4666-8666-666666666666";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
const environment = { versionId: "99999999-9999-4999-8999-999999999999", repositoryId: "123", variables: { SHARED: "from-variable" },
  files: [{ path: ".env.local", content: "FILE_ONLY=from-file\nSHARED=from-file\n" }, { path: "config/dev.env", content: "NESTED=1\n" }] };

it("writes a context's env files privately under its own directory and loads their pairs under the person's variables", async () => {
  const home = await mkdtemp(join(tmpdir(), "zeros-personal-")); directories.push(home);
  const personal = new PersonalEnvironments(home);
  const result = await personal.materialize(CONTEXT, environment);
  expect(result.directory).toBe(join(home, ".zeros", "contexts", CONTEXT, "env"));
  expect(result.variables).toEqual({ FILE_ONLY: "from-file", NESTED: "1", SHARED: "from-variable" });
  expect((await stat(result.directory)).mode & 0o777).toBe(0o700);
  expect((await stat(join(home, ".zeros", "contexts", CONTEXT))).mode & 0o777).toBe(0o700);
  expect((await stat(join(result.directory, "config"))).mode & 0o777).toBe(0o700);
  expect((await stat(join(result.directory, ".env.local"))).mode & 0o777).toBe(0o600);
  expect(await readFile(join(result.directory, "config/dev.env"), "utf8")).toBe("NESTED=1\n");
  await personal.erase(CONTEXT);
  await expect(stat(join(home, ".zeros", "contexts", CONTEXT))).rejects.toMatchObject({ code: "ENOENT" });
});

it("refuses a path that would leave the context's directory, and a context id that is not one", async () => {
  const home = await mkdtemp(join(tmpdir(), "zeros-personal-")); directories.push(home);
  const personal = new PersonalEnvironments(home);
  await expect(personal.materialize(CONTEXT, { ...environment, files: [{ path: "../escape", content: "X=1\n" }] })).rejects.toThrow();
  await expect(personal.materialize(CONTEXT, { ...environment, files: [{ path: "/etc/passwd", content: "X=1\n" }] })).rejects.toThrow();
  await expect(personal.materialize("../../x", environment)).rejects.toThrow();
  await expect(stat(join(home, ".zeros", "contexts", CONTEXT))).rejects.toMatchObject({ code: "ENOENT" });
});
