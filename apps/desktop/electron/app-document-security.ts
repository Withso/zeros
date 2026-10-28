/** URL membership never substitutes for native WebContents/frame ownership. */
export function appDocumentPolicy(input: { devUrl?: string; documentUrl: string }) {
  const document = new URL(input.documentUrl);
  const devOrigin = input.devUrl ? new URL(input.devUrl).origin : null;
  const isDocument = (value: string | undefined): boolean => {
    if (!value || value === "null") return false;
    try {
      const url = new URL(value);
      if (url.username || url.password) return false;
      if (devOrigin) return (url.protocol === "http:" || url.protocol === "https:") && url.origin === devOrigin;
      return url.protocol === "file:" && url.host === document.host && url.pathname === document.pathname;
    } catch { return false; }
  };
  return {
    isDocument,
    request(value: { owned: boolean; isMainFrame?: boolean; currentUrl?: string; requestingUrl?: string; requestingOrigin?: string; securityOrigin?: string }): boolean {
      if (!value.owned || value.isMainFrame !== true || !isDocument(value.currentUrl) || !isDocument(value.requestingUrl)) return false;
      const expectedOrigin = devOrigin ?? "file://";
      return [value.requestingOrigin, value.securityOrigin].every(origin => origin === undefined || origin === expectedOrigin);
    },
  };
}
