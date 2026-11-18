// Part 8 of the migration suite (migrations.test-suite.ts, which needs TEST_DATABASE_URL). See migrations-part.ts.
import { selectMigrationPart } from "./migrations-part.js";

selectMigrationPart(8);
await import("./migrations.test-suite.js");
