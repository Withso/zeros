import { useState, type ComponentType } from "react";
import {
  useNativeAppIcon,
  useToolArtworkImage,
} from "../../../platform/native-app-artwork";
import { useThemeVariant } from "../../../shared/theme/use-theme-variant";
import { cn } from "../../../shared/ui/cn";
import { toolRecord } from "./native-tool-presentation";

/** Native artwork augments the existing action glyphs. It never changes tool
 * status, approval state, or the standard expand/focus behavior. */
export function ToolIdentityIcon({
  artwork,
  appId,
  faviconUrl,
  fallback: Fallback,
  active = true,
  className,
}: {
  artwork?: unknown;
  appId?: string;
  faviconUrl?: string;
  fallback: ComponentType<{ className?: string }>;
  active?: boolean;
  className?: string;
}) {
  const theme = useThemeVariant();
  const nativeIcon = useNativeAppIcon(appId, active);
  const value = toolRecord(artwork);
  const favicon = useToolArtworkImage(faviconUrl, active);
  const providerIcon = useToolArtworkImage(
    theme === "dark" ? (value.iconDark ?? value.icon) : value.icon,
    active,
  );
  const [failed, setFailed] = useState<readonly string[]>([]);
  const source = [favicon, nativeIcon, providerIcon].find(
    (source) => source && !failed.includes(source),
  );
  if (!source || !active) return <Fallback className={className} />;
  return (
    <img
      key={source}
      src={source}
      alt=""
      referrerPolicy="no-referrer"
      crossOrigin={source.startsWith("https:") ? "anonymous" : undefined}
      onError={() => setFailed((current) => [...current.slice(-7), source])}
      className={cn("size-full object-contain", className)}
      draggable={false}
    />
  );
}
