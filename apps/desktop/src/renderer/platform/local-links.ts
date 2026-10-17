import {
  parseLocalLink,
  type LocalLink,
  type LocalLinkScheme,
} from "@zeros/protocol/local-orchestration";
import { isChannel, schemeForChannel } from "../../engine/runtime";
import { CHANNEL } from "../config/release-channel";
import { isNativeRuntime, nativeInvoke, nativeListen } from "./runtime";

let scheme: Promise<LocalLinkScheme> | null = null;
let navigationSubscription: object | null = null;
const inlineNavigation = new Set<(href: string) => void>();

/** In-app pills use exactly the passive deep-link route, without another IPC
 * or an OS URL launch (which could open a different release channel). */
export function openLocalLink(href: string): void {
  for (const deliver of inlineNavigation) deliver(href);
}

/** app_info is main's channel, also used by the auth handoff. Build-time
 * CHANNEL is the fallback for browser previews and older native shells. */
export function resolveLocalLinkScheme(): Promise<LocalLinkScheme> {
  return (scheme ??= (async () => {
    try {
      const info = await nativeInvoke<{ channel?: unknown }>("app_info");
      if (isChannel(info?.channel)) return schemeForChannel(info.channel);
    } catch {
      /* Keep this renderer's build channel. */
    }
    return schemeForChannel(CHANNEL);
  })());
}

/** Subscribe before consuming the windowless intent. A live event that races
 * the IPC reply wins; neither malformed nor foreign-channel URLs reach UI. */
export async function onLocalNavigation(
  handler: (link: LocalLink) => void,
): Promise<() => void> {
  const native = isNativeRuntime();
  const subscription = {};
  navigationSubscription = subscription;
  let active = true;
  const current = () => active && navigationSubscription === subscription;
  let revision = 0;
  let sawLiveEvent = false;
  const deliver = (value: unknown) => {
    const link = typeof value === "string" ? parseLocalLink(value) : null;
    if (!link) return;
    const ticket = ++revision;
    void resolveLocalLinkScheme().then((expected) => {
      if (current() && ticket === revision && link.scheme === expected)
        handler(link);
    });
  };
  const deliverInline = (value: string) => { sawLiveEvent = true; deliver(value); };
  inlineNavigation.add(deliverInline);
  const off = native ? await nativeListen<unknown>("local-navigation", (value) => {
    sawLiveEvent = true;
    deliver(value);
  }).catch((error: unknown) => {
    inlineNavigation.delete(deliverInline);
    if (navigationSubscription === subscription) navigationSubscription = null;
    throw error;
  }) : () => {};
  if (!current()) {
    off();
    inlineNavigation.delete(deliverInline);
    return () => {};
  }
  if (native) void nativeInvoke<unknown>("local_navigation_ready")
    .then((value) => {
      if (current() && !sawLiveEvent) deliver(value);
    })
    .catch(() => {});
  return () => {
    active = false;
    off();
    inlineNavigation.delete(deliverInline);
    if (navigationSubscription === subscription) {
      navigationSubscription = null;
      if (native) void nativeInvoke("local_navigation_ready", { ready: false }).catch(
        () => {},
      );
    }
  };
}
