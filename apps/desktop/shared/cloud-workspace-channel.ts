// Configuration, not a server import: bundlers bake these public switches into
// Electron and the renderer. Keeping the JSON in the standalone CP's source
// also includes it in that deployment without a generated or copied policy.
import channels from "../../control-plane/src/cloud-workspace-channels.json";

const deploymentChannel = { dev: "development", alpha: "alpha", beta: "beta", stable: "production" } as const;

export const CLOUD_WORKSPACE_CHANNELS = (Object.keys(deploymentChannel) as (keyof typeof deploymentChannel)[])
  .filter(channel => channels[deploymentChannel[channel]] === true);

export function cloudWorkspaceChannelEnabled(channel: string): boolean {
  return CLOUD_WORKSPACE_CHANNELS.some(allowed => allowed === channel);
}
