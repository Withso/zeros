import {z} from "zod";
import {CloudLspRequestSchema} from "./cloud-lsp";
const file=z.string().min(1).max(4096).refine(value=>!value.includes("\0"));
const digest=z.string().regex(/^[a-f0-9]{64}$/).nullable();
export const CloudAgentToolInputSchema=z.discriminatedUnion("operation",[
  z.object({operation:z.literal("lsp"),request:CloudLspRequestSchema}).strict(),
  z.object({operation:z.literal("read"),path:file,offset:z.number().int().min(0).max(1_073_741_824).default(0),length:z.number().int().min(1).max(65536).default(65536)}).strict(),
  z.object({operation:z.literal("list"),path:file.default("."),limit:z.number().int().min(1).max(500).default(200)}).strict(),
  z.object({operation:z.literal("search"),path:file.default("."),pattern:z.string().min(1).max(4096)}).strict(),
  z.object({operation:z.literal("write"),path:file,content:z.string().max(65536),expectedSha256:digest}).strict(),
  z.object({operation:z.literal("replace"),path:file,oldText:z.string().min(1).max(65536),newText:z.string().max(65536),expectedSha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
  z.object({operation:z.literal("exec"),command:z.string().min(1).max(32768).refine(value=>!value.includes("\0")),background:z.boolean().default(false),timeoutMs:z.number().int().min(100).max(300000).default(30000)}).strict(),
  z.object({operation:z.literal("poll"),processId:z.uuid(),cursor:z.number().int().min(0).safe().default(0)}).strict(),
  z.object({operation:z.literal("input"),processId:z.uuid(),text:z.string().max(65536),close:z.boolean().default(false)}).strict(),
  z.object({operation:z.literal("stop"),processId:z.uuid()}).strict(),
]);
export type CloudAgentToolInput=z.infer<typeof CloudAgentToolInputSchema>;
export type CloudAgentToolResult={ok:true;data:unknown}|{ok:false;error:"invalid_input"|"unavailable"|"capacity"|"conflict"|"not_found"|"denied"|"timeout"|"output_limit"};
export interface CloudAgentToolBridge {
  readonly inputSchema:Record<string,unknown>;
  call(input:unknown,signal?:AbortSignal):Promise<CloudAgentToolResult>;
}
