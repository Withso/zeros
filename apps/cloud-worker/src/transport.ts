import type { CloudV2WorkerFrame } from "@zeros/protocol/cloud-v2-relay";

export interface TransportHandlers {
  open(): void | Promise<void>;
  frame(raw: unknown): Promise<void>;
  close(): void;
}

/** No offline queue: native work stays in the session store, and a fresh
 * connection backfills history. Replaying opaque prompt frames is unsafe. */
export interface Transport {
  start(handlers: TransportHandlers): void;
  send(frame: CloudV2WorkerFrame): Promise<boolean>;
  dispose(): Promise<void>;
}
