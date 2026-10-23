import { useEffect, useRef, useState } from "react";

/** Only an open preview owns a portal or reads. Timers belong to the exact row
 * and are cancelled when it disappears or its retained sidebar becomes inert. */
export function useSidebarWorkspacePreview(key: string, enabled: boolean) {
  const [openedKey, setOpenedKey] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const contentRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuOpen = useRef(false);
  const cancel = () => {
    clearTimeout(timer.current);
    timer.current = undefined;
  };
  const close = () => {
    cancel();
    setOpenedKey(null);
  };
  useEffect(() => {
    setOpenedKey(null);
    menuOpen.current = false;
    return () => clearTimeout(timer.current);
  }, [key, enabled]);

  const scheduleClose = () => {
    cancel();
    timer.current = setTimeout(() => {
      if (menuOpen.current || contentRef.current?.contains(document.activeElement)) return;
      setOpenedKey(null);
    }, 180);
  };

  return {
    open: enabled && openedKey === key,
    contentRef,
    triggerRef,
    cancel,
    close,
    scheduleClose,
    scheduleOpen: () => {
      cancel();
      if (enabled) timer.current = setTimeout(() => setOpenedKey(key), 400);
    },
    setMenuOpen: (open: boolean) => {
      menuOpen.current = open;
      if (open) cancel();
      else scheduleClose();
    },
  };
}
