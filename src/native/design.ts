import { isNativeRuntime, nativeInvoke } from "./runtime";

export interface DesignPngExportResult {
  saved: boolean;
  path?: string;
}

function downloadPng(dataUrl: string, suggestedName: string): void {
  const anchor = document.createElement("a");
  anchor.href = dataUrl;
  anchor.download = suggestedName.toLowerCase().endsWith(".png")
    ? suggestedName
    : `${suggestedName}.png`;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export async function exportDesignPng(
  dataUrl: string,
  suggestedName: string,
): Promise<DesignPngExportResult> {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match?.[1]) throw new Error("Design screenshot is not a PNG image.");
  if (!isNativeRuntime()) {
    downloadPng(dataUrl, suggestedName);
    return { saved: true };
  }
  return nativeInvoke<DesignPngExportResult>("design_export_png", {
    data: match[1],
    suggestedName,
  });
}
