type DesignResource = "frameSurfaces" | "documentBuffers" | "nativeDocumentBuffers" | "sourceDocumentBuffers" | "sourceVectorBuffers" | "incomingDocumentBuffers" | "tileRequests";
const counts: Record<DesignResource, { current: number; peak: number; admitted: number }> = {
  frameSurfaces: { current: 0, peak: 0, admitted: 0 },
  documentBuffers: { current: 0, peak: 0, admitted: 0 },
  nativeDocumentBuffers: { current: 0, peak: 0, admitted: 0 },
  sourceDocumentBuffers: { current: 0, peak: 0, admitted: 0 },
  sourceVectorBuffers: { current: 0, peak: 0, admitted: 0 },
  incomingDocumentBuffers: { current: 0, peak: 0, admitted: 0 },
  tileRequests: { current: 0, peak: 0, admitted: 0 },
};

/** Allocation-boundary counters only: no timer, DOM scan, source or owner
 * identifiers. Tile requests count callers, not native capture completion. */
export function retainDesignResource(resource: DesignResource): () => void {
  const counter = counts[resource];
  counter.current++;
  counter.admitted++;
  counter.peak = Math.max(counter.peak, counter.current);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    counter.current--;
  };
}

export function designResourceCounters() {
  return Object.fromEntries(Object.entries(counts).map(([key, counter]) => [key, { ...counter }]));
}
