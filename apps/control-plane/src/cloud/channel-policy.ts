import channels from "./channels.json" with { type: "json" };

/** Cloud rollout remains limited to development and Alpha. */
export function cloudWorkspaceChannelEnabled(channel: string): boolean {
  return Object.hasOwn(channels, channel) && channels[channel as keyof typeof channels];
}
