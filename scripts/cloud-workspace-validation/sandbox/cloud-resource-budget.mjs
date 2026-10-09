import * as fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { isCloudDeploymentOwner } from "./cloud-runtime-root.mjs";
import { validCloudResourceBudgetProjection } from "./cloud-resource-admission.mjs";

const PROJECTION = "/etc/zeros/cloud-resource-contract.json";
const MAX_BYTES = 16384;
function refused() { return new Error("Cloud resource budget projection is invalid"); }

/** Duplicate-key rejection precedes JSON.parse, including escaped aliases.
 * Unknown document keys are rejected by the strict projection predicate. */
export function parseCloudResourceBudgetProjection(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > MAX_BYTES) throw refused();
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes), objects = [];
  for (let index = 0; index < source.length; index++) {
    if (source[index] === "{") objects.push(new Set());
    else if (source[index] === "}") objects.pop();
    else if (source[index] === '"') {
      const start = index++;
      for (; index < source.length; index++) {
        if (source[index] === "\\") index++;
        else if (source[index] === '"') break;
      }
      let next = index + 1;
      while (next < source.length && /\s/.test(source[next])) next++;
      if (source[next] === ":") {
        const key = JSON.parse(source.slice(start, index + 1)), keys = objects.at(-1);
        if (!keys || !/^[\x20-\x7e]+$/.test(key) || keys.has(key)) throw refused();
        keys.add(key);
      }
    }
  }
  const value = JSON.parse(source);
  if (!validCloudResourceBudgetProjection(value)) throw refused();
  return value;
}

/** The actual engine reads only the root's fixed readonly projection. The IO
 * and owner seams are explicit portable fixtures, never runtime authority.
 * @param {{lstatSync:(file:string)=>import('node:fs').Stats,realpathSync:(file:string)=>string,
 * openSync:(file:string,flags:number)=>number,fstatSync:(fd:number)=>import('node:fs').Stats,
 * readSync:(fd:number,buffer:Buffer,offset:number,length:number,position:null)=>number,
 * closeSync:(fd:number)=>void}} io
 * @param {(file:string,uid:number)=>boolean} isOwner
 */
export function readCloudResourceBudgetProjection(io = fs, isOwner = isCloudDeploymentOwner) {
  const fd = io.openSync(PROJECTION, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    for (let cursor = PROJECTION; ; cursor = path.dirname(cursor)) {
      const metadata = io.lstatSync(cursor);
      if (metadata.isSymbolicLink() || io.realpathSync(cursor) !== cursor || !isOwner(cursor, metadata.uid) ||
          metadata.mode & 0o022 || (cursor === PROJECTION ? !metadata.isFile() || metadata.nlink !== 1 : !metadata.isDirectory())) throw refused();
      if (cursor === "/") break;
    }
    const opened = io.fstatSync(fd), current = io.lstatSync(PROJECTION);
    if (!opened.isFile() || !isOwner(PROJECTION, opened.uid) || opened.nlink !== 1 || (opened.mode & 0o7777) !== 0o444 ||
        opened.dev !== current.dev || opened.ino !== current.ino || current.isSymbolicLink() ||
        opened.size < 2 || opened.size > MAX_BYTES) throw refused();
    const buffer = Buffer.alloc(opened.size + 1); let size = 0;
    while (size < buffer.length) {
      const count = io.readSync(fd, buffer, size, buffer.length - size, null);
      if (count === 0) break;
      size += count;
    }
    if (size !== opened.size) throw refused();
    return parseCloudResourceBudgetProjection(buffer.subarray(0, size));
  } finally { io.closeSync(fd); }
}
