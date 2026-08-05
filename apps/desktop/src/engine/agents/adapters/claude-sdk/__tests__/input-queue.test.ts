import { describe, expect, it } from "vitest";

import { InputQueue, createDeferred } from "../input-queue";

async function collectN<T>(it: AsyncIterator<T>, n: number): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < n; i++) {
    const r = await it.next();
    if (r.done) break;
    out.push(r.value);
  }
  return out;
}

describe("InputQueue", () => {
  it("delivers a buffered item pushed before next()", async () => {
    const q = new InputQueue<number>();
    q.push(1);
    const it = q[Symbol.asyncIterator]();
    expect((await it.next()).value).toBe(1);
  });

  it("delivers an item pushed AFTER next() is parked (the streaming case)", async () => {
    const q = new InputQueue<number>();
    const it = q[Symbol.asyncIterator]();
    const pending = it.next();
    q.push(42);
    expect((await pending).value).toBe(42);
  });

  it("preserves FIFO order across multiple buffered pushes", async () => {
    const q = new InputQueue<number>();
    q.push(1);
    q.push(2);
    q.push(3);
    const it = q[Symbol.asyncIterator]();
    expect(await collectN(it, 3)).toEqual([1, 2, 3]);
  });

  it("end() completes a parked next() with done:true and marks closed", async () => {
    const q = new InputQueue<number>();
    const it = q[Symbol.asyncIterator]();
    const pending = it.next();
    expect(q.closed).toBe(false);
    q.end();
    expect((await pending).done).toBe(true);
    expect(q.closed).toBe(true);
  });

  it("ignores push() after end()", async () => {
    const q = new InputQueue<number>();
    q.end();
    q.push(99);
    const it = q[Symbol.asyncIterator]();
    expect((await it.next()).done).toBe(true);
  });

  it("return() ends the queue (SDK stops iterating)", async () => {
    const q = new InputQueue<number>();
    const it = q[Symbol.asyncIterator]();
    await it.return!();
    expect(q.closed).toBe(true);
  });
});

describe("createDeferred", () => {
  it("resolves externally", async () => {
    const d = createDeferred<string>();
    d.resolve("ok");
    expect(await d.promise).toBe("ok");
  });

  it("rejects externally", async () => {
    const d = createDeferred<string>();
    d.reject(new Error("nope"));
    await expect(d.promise).rejects.toThrow("nope");
  });
});
