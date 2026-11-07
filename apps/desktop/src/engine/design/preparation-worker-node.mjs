// Node runs the TypeScript worker through tsx, registered here: a worker's
// execArgv does not install a loader on every Node version. Bun loads the
// worker directly and never uses this file.
import { workerData } from "node:worker_threads";
import { register } from "tsx/esm/api";

register();
await import(workerData.entry);
