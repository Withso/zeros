import { fileRefPath } from "../markdown-file-path";
import { isLoopbackUrl } from "@/renderer/shell/workbench/tabs/localhost-url";
import type { RendererContext } from "./types";

/** Only known browser schemes navigate. Provider resource URIs remain readable
 * but never become arbitrary OS protocol handlers. Files keep the cwd boundary. */
export function ToolResourceLink({
  uri,
  label,
  ctx,
}: {
  uri: string;
  label: string;
  ctx: RendererContext;
}) {
  const path = fileRefPath(uri, true);
  if (path)
    return (
      <button
        type="button"
        className="zeros-md-filepath"
        data-file-path={path}
        title={path}
        onPointerEnter={() => {
          if (ctx.attachmentImagesActive !== false) ctx.warmFile?.(path);
        }}
        onFocus={() => {
          if (ctx.attachmentImagesActive !== false) ctx.warmFile?.(path);
        }}
        onClick={() => ctx.openFile?.(path)}
      >
        {label}
      </button>
    );
  if (!/^(https?:\/\/|mailto:)/i.test(uri))
    return <span title={uri}>{label === uri ? uri : `${label} — ${uri}`}</span>;
  return (
    <a
      href={uri}
      title={uri}
      target="_blank"
      rel="noopener noreferrer"
      data-local-preview={isLoopbackUrl(uri) ? "" : undefined}
      onClick={(event) => {
        if (ctx.openPreviewUrl?.(uri) || ctx.openPrUrl?.(uri))
          event.preventDefault();
      }}
    >
      {label}
    </a>
  );
}
