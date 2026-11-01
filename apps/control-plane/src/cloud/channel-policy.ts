import channels from "./channels.json" with { type: "json" };

/** The checked-in cloud policy; a channel set to `false` is paused. */
export function cloudWorkspaceChannelEnabled(channel: string): boolean {
  return Object.hasOwn(channels, channel) && channels[channel as keyof typeof channels];
}
