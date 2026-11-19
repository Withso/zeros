// The control-plane requests this app sends and the parsers it applies to the
// replies. Its JSON form is committed as
// apps/control-plane/src/client-contracts/desktop-next.json; each release keeps
// a copy, and the control plane replays every kept copy so a backend change
// cannot break an app that is still supported.
//
// Entries reuse the exact schemas and headers their call sites use. Paths take
// {organizationId}, {workspaceId} and {chatId} placeholders that the replay fills
// from its fixture.
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

/** The committed JSON form. Replies are checked against the parser's INPUT
 * schema: what the released app accepts. Refinements and transforms that JSON
 * Schema cannot express are left out, which can miss a break but never invents
 * one. */
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
