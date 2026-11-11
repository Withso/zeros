import { useEffect } from "react";
import { noteAttention, startNotifyUser } from "../../platform/notify-user";
import { setAttentionHandler } from "./sessions-store";

/** notify-user-v1 for the signed-in app: unread marks, main's notification
 * decision, and opening a clicked notification's chat. Renders nothing. */
export function NotifyUserHost(): null {
  useEffect(() => {
    setAttentionHandler((chatId, update) => { noteAttention(chatId, update); });
    const stop = startNotifyUser();
    return () => { setAttentionHandler(null); stop(); };
  }, []);
  return null;
}
