// Scopes vitest to this package — without this, vitest resolves the repo
// root's config (the Electron app's test include list) and finds nothing.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // Migrates TEST_DATABASE_URL once and records the baseline that
    // resetMigratedTestDatabase() restores between integration tests.
    globalSetup: ["./src/test-database-global-setup.ts"],
    // The DB-backed files (integration, migrations) share ONE Postgres and each
    // resets the public schema, so running files in parallel makes them
    // clobber each other mid-run. They also both apply 0004, whose
    // `CREATE ROLE zeros_app` guard is a check-then-create on a CLUSTER-wide
    // object — two concurrent runs can both see it missing and one then fails
    // with duplicate_object. Keep schema-mutating files serial; CI splits the
    // files across separate Postgres services with `--shard` instead.
    fileParallelism: false,
  },
});
