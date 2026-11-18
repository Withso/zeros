// Part 4 of the migration suite (migrations.test-suite.ts, which needs TEST_DATABASE_URL). See migrations-part.ts.
import { selectMigrationPart } from "./migrations-part.js";

selectMigrationPart(4);
await import("./migrations.test-suite.js");
