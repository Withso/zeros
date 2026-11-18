// Part 6 of the migration suite (migrations.suite.ts, which needs TEST_DATABASE_URL). See migrations-part.ts.
import { selectMigrationPart } from "./migrations-part.js";

selectMigrationPart(6);
await import("./migrations.suite.js");
