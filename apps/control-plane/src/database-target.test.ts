import { afterEach, expect, it, vi } from "vitest";
import pg from "pg";
import {
  parseDatabaseTarget,
  validateMigrationRole,
} from "./database-target.js";
const fixture = new URL("postgresql://primary.pg.psdb.cloud/postgres?sslmode=verify-full");
fixture.username = "operator.branchalpha";
fixture.password = "synthetic";
const url = fixture.toString();
afterEach(() => vi.unstubAllEnvs());
it.each([
  "host",
  "hostaddr",
  "port",
  "user",
  "password",
  "database",
  "dbname",
  "connectionstring",
  "options",
  "USER",
])("rejects the pg %s query override", (name) => {
  expect(() => parseDatabaseTarget(url + "&" + name + "=another")).toThrow(
    /override/,
  );
});
it.each([
  "sslmode=require",
  "SSLMODE=require",
  "application_name=a&application_name=b",
])("rejects duplicate parameters including case differences: %s", (suffix) => {
  expect(() => parseDatabaseTarget(url + "&" + suffix)).toThrow(/duplicate/);
});
it("materializes the effective primary route despite ambient driver defaults", () => {
  vi.stubEnv("PGPORT", "6432");
  vi.stubEnv("PGUSER", "unreviewed.branchbeta");
  const normalized = parseDatabaseTarget(url).toString();
  const driver = new pg.Client({ connectionString: normalized });
  const effective = (
    driver as unknown as {
      connectionParameters: { port: number; user: string };
    }
  ).connectionParameters;
  expect(effective.port).toBe(5432);
  expect(effective.user).toBe("operator.branchalpha");
});
it("requires an explicit route login and rejects pooler roles and insecure PlanetScale TLS", () => {
  expect(() => parseDatabaseTarget("postgres://primary.test/app")).toThrow(
    /explicit login/,
  );
  expect(() =>
    parseDatabaseTarget(
      url.replace("operator.branchalpha", "operator.branchalpha|replica"),
    ),
  ).toThrow();
  expect(() =>
    parseDatabaseTarget(url.replace("verify-full", "require")),
  ).toThrow(/verify-full/);
});
it("canonicalizes encoded login and database without including password in target fields", () => {
  const parsed = parseDatabaseTarget(
    url.replace("operator.branchalpha", "operator%2Ebranchalpha").replace("primary.pg", "PRIMARY.pg").replace("/postgres?", "/%70ostgres?"),
  );
  expect(parsed.username).toBe("operator.branchalpha");
  expect(parsed.pathname).toBe("/postgres");
  expect(parsed.hostname).toBe("primary.pg.psdb.cloud");
  expect(parsed.port).toBe("5432");
});
it("validates only one stable migration owner identifier", () => {
  expect(validateMigrationRole("postgres")).toBe("postgres");
  for (const value of [
    "",
    "zeros_app",
    "postgres -c superuser=true",
    "postgres;RESET ROLE",
    "postgres,other",
  ])
    expect(() => validateMigrationRole(value)).toThrow();
});

it.each(["review@alpha", "review:alpha", "review$alpha", "review+alpha", "review%25alpha"])("preserves the driver's effective database for %s", (database) => {
  const original = `postgres://operator@database.test/${database}`;
  const before = new pg.Client({connectionString:original}).database;
  const after = new pg.Client({connectionString:parseDatabaseTarget(original).toString()}).database;
  expect(after).toBe(before);
});
it.each(["review%40alpha", "review%3Aalpha", "review%24alpha", "review%2Balpha"])("rejects ambiguous encoded database delimiters: %s", (database) => {
  expect(() => parseDatabaseTarget(`postgres://operator@database.test/${database}`)).toThrow(/database delimiter/);
});
