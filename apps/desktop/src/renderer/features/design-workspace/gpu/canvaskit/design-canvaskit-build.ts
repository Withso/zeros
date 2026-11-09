// Identity of the vendored CanvasKit build (see README.md and build.sh in this
// directory). A unit test hashes the committed files against these pins, so
// replacing either file without rebuilding from the recorded inputs fails.

export const DESIGN_CANVASKIT_VERSION = "0.42.0";
/** Skia's `canvaskit/0.42.0` tag. */
export const DESIGN_CANVASKIT_SKIA_REVISION = "e2def78fa232884d4aedcf3ad92d4a0dd673b898";
export const DESIGN_CANVASKIT_EMSDK_VERSION = "4.0.7";
/** The flags `modules/canvaskit/Makefile` passes for the npm package's bin/. */
export const DESIGN_CANVASKIT_BUILD_FLAGS = Object.freeze(["release", "no_skottie", "no_sksl_trace", "no_alias_font",
  "no_effects_deserialization", "no_encode_jpeg", "no_encode_webp", "legacy_draw_vertices", "no_embedded_font"]);

export const DESIGN_CANVASKIT_SHA256 = Object.freeze({
  "canvaskit.js": "87ea84a4a5daf52e86f6359f15bf735c4b36ac0ecbee30a2cb2bdfcde55e5d3e",
  "canvaskit.wasm": "0686b7a7cecbc77b1413f6d652e3b0415d5586840362409b555d70c0ac37edce",
  "zeros-design.patch": "e36677b25bf1ebd097a522a2d976ee7e2eefb7639daa18b6a4304f0c87cb74e2",
});

/** The unpatched build of the same inputs, byte-identical to the published
 * npm canvaskit-wasm@0.42.0 bin/ files. */
export const DESIGN_CANVASKIT_STOCK_SHA256 = Object.freeze({
  "canvaskit.js": "443777592179808354031cf411d8d43cac9f6b98d1227123c5c22d401b0fbf7f",
  "canvaskit.wasm": "25ebed8e60158c5854f8dc807b936daca21354f8bfb6a2231266b0a93812f301",
});
