// The recorded canvas's wire contract is the protocol's own
// (`@zeros/protocol/design-capture`); this module names the parts the
// renderer derives from it.
import { DESIGN_BATCH_CAPTURE_MAX_ITEMS, type DesignRecording, type DesignRecordingsReply } from "@zeros/protocol/design-capture";

export {
  DESIGN_RECORDING_CHUNK_ID_PATTERN,
  DESIGN_RECORDING_CHUNK_MAX_BYTES,
  DESIGN_RECORDING_MAX_BYTES,
  DESIGN_RECORDING_MAX_LAYERS,
  DESIGN_RECORDING_MAX_TYPEFACES,
  DESIGN_RECORDING_TYPEFACE_MAX_BYTES,
  DESIGN_RECORDINGS_CAPABILITY,
  DESIGN_RECORDINGS_KNOWN_CHUNKS,
  DESIGN_RECORDINGS_READ_FAILURES_CAPABILITY,
  DESIGN_RECORDINGS_REPLY_DATA_BYTES,
  designRecordingsReadReplySchema,
  designRecordingsReadSchema,
  designRecordingsRenderSchema,
  designRecordingsReplySchema,
  type DesignRecording,
  type DesignRecordingsRead,
  type DesignRecordingsReadReply,
  type DesignRecordingsRender,
  type DesignRecordingsReply,
} from "@zeros/protocol/design-capture";

/** Engines that take a request's `colorScheme` and keep each scheme's
 * recordings apart. The name is the renderer's until the protocol has it. */
export const DESIGN_RECORDINGS_COLOR_SCHEME_CAPABILITY = "design.recordings.color-scheme.v1";
/** Frames per render request: a batch capture's item limit. */
export const DESIGN_RECORDINGS_RENDER_FRAMES = DESIGN_BATCH_CAPTURE_MAX_ITEMS;
export type DesignRecordingLayer = DesignRecording["layers"][number];
export type DesignRecordingTypeface = DesignRecordingsReply["typefaces"][number];
