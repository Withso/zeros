import { describe, expect, it } from "vitest";
import { libpqEnvironment } from "../dev-environment/postgres.mjs";

describe("libpq child environment", () => {
  it("splits a loopback connection URL into libpq variables, never a URI in PGDATABASE", () => {
    const env = libpqEnvironment("postgresql://zeros_dev_migrator:s3cr%2Ft@127.0.0.1:21000/zeros_dev_owner");
    expect(env).toEqual({ PGHOST: "127.0.0.1", PGPORT: "21000", PGUSER: "zeros_dev_migrator", PGPASSWORD: "s3cr/t", PGDATABASE: "zeros_dev_owner" });
    expect(env.PGDATABASE).not.toContain("://");
  });

  it("refuses non-loopback, query-bearing and incomplete URLs", () => {
    for (const url of ["postgresql://u:p@db.example.test:21000/d", "postgresql://u:p@127.0.0.1:21000/d?sslmode=disable",
      "postgresql://u@127.0.0.1:21000/d", "postgresql://u:p@127.0.0.1/d", "mysql://u:p@127.0.0.1:21000/d"])
      expect(() => libpqEnvironment(url)).toThrow();
  });
});
