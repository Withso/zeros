import { AsyncLocalStorage } from "node:async_hooks";

/** Team sharing (activated): the person and context of the client operation a
 * command runs for. Commands started outside an operation get nothing from it. */
export interface OperationEnvironment { git: Readonly<Record<string, string>>; zeros: Readonly<Record<string, string>> }
export const operationEnvironment = new AsyncLocalStorage<OperationEnvironment>();
