// Scopes vitest to this package — without this, vitest resolves the repo
// root's config (the Electron app's test include list) and finds nothing.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // The DB-backed files (integration, migrations) share ONE Postgres and each
    // starts by dropping the public schema, so running files in parallel makes
    // them clobber each other mid-run. They also both apply 0004, whose
    // `CREATE ROLE zeros_app` guard is a check-then-create on a CLUSTER-wide
    // object — two concurrent runs can both see it missing and one then fails
    // with duplicate_object. Keep schema-mutating files serial; optimize their
    // individual fixtures rather than running shared-schema resets concurrently.
    fileParallelism: false,
  },
});
