import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { CodeReviewStoreCore } from "@zeros/protocol/code-review";
import { openZerosDb } from "./database";

export class CodeReviewStore extends CodeReviewStoreCore {
  constructor(database: () => Database.Database = openZerosDb) {
    super(database, {
      hash: value => createHash("sha256").update(value).digest("hex"), uuid: randomUUID,
      encode: value => Buffer.from(value).toString("base64url"),
      decode: value => Buffer.from(value, "base64url").toString("utf8"),
    });
  }
}
export const codeReviewStore = new CodeReviewStore();
