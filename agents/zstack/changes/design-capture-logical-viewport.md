# Keep capture crops separate from the document viewport

- **Symptom.** Deep-zoom pixels changed media-query colors and viewport-unit
  layout while the live iframe and selection geometry stayed unchanged.
- **Cause.** A cropped SVG image used the crop's dimensions as its CSS viewport;
  fixing the cloned HTML width did not preserve media queries or `vw`/`vh`.
- **Rule.** Keep the serialized SVG at the authored logical viewport and crop
  only when drawing into the bounded output raster. Check both responsive CSS
  and viewport units, not only absolute-positioned shapes or output dimensions.
- **Encoded in.** `packages/protocol/src/__tests__/design-runtime-capture-viewport.test.ts`
  and the existing tiny-crop high-resolution test in `design-runtime.test.ts`;
  eval case `design-capture-logical-viewport`.
