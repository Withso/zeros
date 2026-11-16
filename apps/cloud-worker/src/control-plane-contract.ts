// The control-plane requests this runtime sends and the parsers it applies to
// the replies, in the order a boot sends them. Its JSON form is committed as
// apps/control-plane/src/client-contracts/worker-next.json; each release keeps
// a copy, and the control plane replays every kept copy. During a runtime
// handover the previous pin still talks to the new control plane, and config
// frames are strict, so a field this runtime does not know must stay gated on
// the features it advertises.
//
// The transport builds these bodies and parses these replies through the same
// helpers. Bodies take {runtimeSha256} and {bootId} placeholders that the replay
// fills from its fixture; it supplies the bearer token and boot header itself.
import { z } from "zod";
import { CLOUD_V2_RELAY_PROTOCOL, CloudV2ControlFrameSchema, CloudV2WorkerActivityReplySchema } from "@zeros/protocol/cloud-v2-relay";
import { CLOUD_WORKER_FEATURES } from "./worker-features";

export const WORKER_CONTRACT_PLACEHOLDERS = ["runtimeSha256", "bootId"] as const;
export const WORKER_FEATURES_HEADER = { "X-Zeros-Worker-Features": CLOUD_WORKER_FEATURES } as const;

export const helloBody = (runtimeSha256: string, bootId: string) => ({ protocol: CLOUD_V2_RELAY_PROTOCOL, runtimeSha256, bootId });
export const activityBody = (idle: boolean) => ({ idle });
/** hello and config both answer `{ config }`, a control frame. */
export const WorkerConfigReplySchema = z.object({ config: CloudV2ControlFrameSchema });

type WorkerContractEntry = {
  id: string;
  method: "GET" | "POST";
  path: string;
  body?: Record<string, unknown>;
  response: z.ZodType;
};

export const WORKER_CONTROL_PLANE_CONTRACT: readonly WorkerContractEntry[] = [
  { id: "worker.hello", method: "POST", path: "hello", body: helloBody("{runtimeSha256}", "{bootId}"), response: WorkerConfigReplySchema },
  { id: "worker.config", method: "GET", path: "config", response: WorkerConfigReplySchema },
  { id: "worker.activity", method: "POST", path: "activity", body: activityBody(true), response: CloudV2WorkerActivityReplySchema },
];

/** The committed JSON form; replies are checked against each parser's input schema. */
export function workerContractDocument() {
  return {
    version: 1,
    client: "worker",
    headers: { ...WORKER_FEATURES_HEADER },
    entries: WORKER_CONTROL_PLANE_CONTRACT.map(({ response, ...entry }) => ({
      ...entry,
      response: z.toJSONSchema(response, { io: "input", unrepresentable: "any" }),
    })),
  };
}
