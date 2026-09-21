import {z} from "zod";

export const CloudLspLanguageSchema=z.enum(["typescript","javascript","python"]);
const file=z.string().min(1).max(4096).refine(value=>!/[\u0000-\u001f\u007f]/.test(value));
const position=z.object({line:z.number().int().min(0).max(1_000_000),character:z.number().int().min(0).max(1_000_000)}).strict();
const base={language:CloudLspLanguageSchema};
/** Disk-backed analysis only. No executable, environment, raw RPC, plugin,
 * server command, URI, or unsaved document content comes from the caller. */
export const CloudLspRequestSchema=z.discriminatedUnion("kind",[
  z.object({...base,kind:z.literal("start")}).strict(),
  z.object({...base,kind:z.literal("stop")}).strict(),
  z.object({...base,kind:z.literal("open"),path:file}).strict(),
  z.object({...base,kind:z.literal("close"),path:file}).strict(),
  z.object({...base,kind:z.literal("documentSymbols"),path:file}).strict(),
  z.object({...base,kind:z.literal("workspaceSymbols"),query:z.string().max(256)}).strict(),
  z.object({...base,kind:z.literal("completions"),path:file,position}).strict(),
]);
export type CloudLspLanguage=z.infer<typeof CloudLspLanguageSchema>;
export type CloudLspRequest=z.infer<typeof CloudLspRequestSchema>;
