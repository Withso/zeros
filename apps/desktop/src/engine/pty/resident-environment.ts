import { z } from "zod";
import { RESIDENT_PTY_PROTOCOL, ResidentEngineAuthoritySchema } from "./resident-protocol";

const Material = z.object({ protocol: z.literal(RESIDENT_PTY_PROTOCOL), hostId: z.uuid(),
  authority: ResidentEngineAuthoritySchema }).strict();

/** Root launch material, consumed before constructing any child environment.
 * An ambient variable alone can never enable the resident cloud adapter. */
export function consumeResidentEnvironment(
  runtime: { execution: { organizationId: string; workspaceId: string; generation: number }; engine: { instanceId: string } } | null,
  version: number | null | undefined,
  env: Record<string, string | undefined> = process.env,
) {
  const encoded = env.ZEROS_RESIDENT_PTY_B64;
  delete env.ZEROS_RESIDENT_PTY_B64;
  if (encoded === undefined) return null;
  let bytes: Buffer | undefined;
  try {
    if (!runtime || version !== 4 || encoded.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error();
    bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) throw new Error();
    const material = Material.parse(JSON.parse(bytes.toString("utf8")));
    const { authority } = material;
    if (authority.organizationId !== runtime.execution.organizationId || authority.workspaceId !== runtime.execution.workspaceId ||
      authority.generation !== runtime.execution.generation || authority.engineId !== runtime.engine.instanceId) throw new Error();
    return { ...material, socketPath: `/run/zeros/resident-${material.hostId}.sock`, servicesRoot: "/tmp/zeros-resident" };
  } catch { throw new Error("Resident cloud authority rejected"); }
  finally { bytes?.fill(0); }
}
