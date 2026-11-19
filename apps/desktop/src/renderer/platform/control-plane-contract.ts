// The control plane replays desktop-next.json and each kept release's copy of the app's request headers and reply schemas.
import { z } from "zod";
import {
  CloudV2ComputerReplySchema,
  CloudV2InstalledRepositoriesReplySchema,
  CloudV2WorkspaceListReplySchema,
  CloudV2WorkspaceReplySchema,
} from "./cloud-v2";
import { CloudV2PromptPageReplySchema } from "./cloud-prompt-api";
import { TEAM_SHARING_HEADERS } from "./control-plane-headers";

export const CONTRACT_PLACEHOLDERS = ["organizationId", "workspaceId", "chatId"] as const;

type ContractEntry = {
  id: string;
  method: "GET";
  path: string;
  headers: Readonly<Record<string, string>>;
  response: z.ZodType;
};

export const CONTROL_PLANE_CONTRACT: readonly ContractEntry[] = [
  {
    id: "cloud-v2.workspaces.list",
    method: "GET",
    path: "/v1/cloud-v2/workspaces?organizationId={organizationId}&archived=include&limit=200",
    headers: TEAM_SHARING_HEADERS,
    response: CloudV2WorkspaceListReplySchema,
  },
  {
    id: "cloud-v2.workspaces.get",
    method: "GET",
    path: "/v1/cloud-v2/workspaces/{workspaceId}",
    headers: TEAM_SHARING_HEADERS,
    response: CloudV2WorkspaceReplySchema,
  },
  {
    id: "cloud-v2.prompts.list",
    method: "GET",
    path: "/v1/cloud-v2/workspaces/{workspaceId}/prompts?chatId={chatId}&after=0&includePayload=false",
    headers: TEAM_SHARING_HEADERS,
    response: CloudV2PromptPageReplySchema,
  },
  {
    id: "cloud-v2.computer.get",
    method: "GET",
    path: "/v1/cloud-v2/organizations/{organizationId}/computer",
    headers: {},
    response: CloudV2ComputerReplySchema,
  },
  {
    id: "cloud-v2.computer.repositories",
    method: "GET",
    path: "/v1/cloud-v2/organizations/{organizationId}/computer/repositories",
    headers: {},
    response: CloudV2InstalledRepositoriesReplySchema,
  },
];

// Export what the app accepts, not transformed output. Omitted rules can hide a break, not invent one.
export function controlPlaneContractDocument() {
  return {
    version: 1,
    client: "desktop",
    entries: CONTROL_PLANE_CONTRACT.map(({ response, ...entry }) => ({
      ...entry,
      headers: { ...entry.headers },
      response: z.toJSONSchema(response, { io: "input", unrepresentable: "any" }),
    })),
  };
}
