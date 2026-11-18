// Part 5 of the migration suite (migrations.suite.ts, which needs TEST_DATABASE_URL). See migrations-part.ts.
import { selectMigrationPart } from "./migrations-part.js";

selectMigrationPart(5);
await import("./migrations.suite.js");
