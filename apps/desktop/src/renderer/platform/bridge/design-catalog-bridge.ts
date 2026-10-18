import {
  DESIGN_CATALOG_READ_CAPABILITY,
  DESIGN_CATALOG_READ_OPERATION,
  designCatalogOwnerSchema,
  designCatalogReadSchema,
  designCatalogReplySchema,
  type DesignCatalogRead,
  type DesignCatalogOwner,
  type DesignCatalogReply,
} from "@zeros/protocol/design-catalog";
import type { RuntimeClient } from "./ws-client";

export async function bridgeDesignCatalog(
  bridge: RuntimeClient,
  input: DesignCatalogRead,
  expectedOwner: DesignCatalogOwner,
): Promise<DesignCatalogReply> {
  const params = designCatalogReadSchema.parse(input);
  const owner = designCatalogOwnerSchema.parse(expectedOwner);
  if (
    owner.workspaceId !== params.workspaceId ||
    owner.directoryId !== params.directoryId
  )
    throw new Error("Design catalog request belongs to another owner.");
  if (!bridge.supportsEngineCapability(DESIGN_CATALOG_READ_CAPABILITY))
    throw new Error(
      "This engine does not support metadata-only Design catalogs.",
    );
  const response = await bridge.requestConnected(
    { type: "WORKSPACE_REQUEST", op: DESIGN_CATALOG_READ_OPERATION, params },
    10_000,
  );
  if (response.type === "WORKSPACE_ERROR") throw new Error(response.message);
  if (
    response.type !== "WORKSPACE_RESPONSE" ||
    response.op !== DESIGN_CATALOG_READ_OPERATION
  )
    throw new Error("Invalid Design catalog response.");
  const result = designCatalogReplySchema.parse(response.result);
  if (
    result.status === "ready" &&
    (result.intent !== params.intent ||
      Object.entries(owner).some(
        ([key, value]) =>
          result.owner[key as keyof DesignCatalogOwner] !== value,
      ))
  )
    throw new Error(
      "Design catalog response belongs to another owner or intent.",
    );
  return result;
}
