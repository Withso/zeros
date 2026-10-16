import channels from "../cloud-workspace-channels.json" with { type: "json" };

/** The checked-in pause is shared with desktop builds and release jobs. A
 * deployment environment can opt out, but cannot override a paused channel.
 * Change the JSON switch and release normally to restore the existing paths. */
export function cloudWorkspaceChannelEnabled(channel: string): boolean {
  return Object.hasOwn(channels, channel) && channels[channel as keyof typeof channels] === true;
}
