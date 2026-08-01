import type { ContentBlock } from "@zeros/core/agent-events";
import type { AgentTextMessageAttachment } from "@zeros/core/agent-messages";

import type { DesignSelectionContext } from "../store/use-design-selection-context";
import type { MentionSelection } from "./mentions";

const CONTEXT_STYLE_KEYS = [
  "position",
  "display",
  "flexDirection",
  "gap",
  "padding",
  "background",
  "border",
  "borderRadius",
  "color",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "lineHeight",
  "letterSpacing",
  "textAlign",
  "overflow",
] as const;

export interface DesignSelectionAttachment {
  blocks: ContentBlock[];
  bubbleAttachments: AgentTextMessageAttachment[];
}

interface DesignSelectionAttachmentOptions {
  includeImage?: boolean;
}

export function designSelectionMention(
  selection: DesignSelectionContext | null,
): MentionSelection | null {
  if (!selection) return null;
  return {
    tag: selection.tag,
    selector: selection.selector,
    componentName: selection.name,
    frame: selection.frame,
    ...(selection.nodeId ? { oid: selection.nodeId } : {}),
  };
}

export function formatDesignSelectionContext(
  selection: DesignSelectionContext,
): string {
  const styleLines = CONTEXT_STYLE_KEYS.flatMap((property) => {
    const value = selection.styles[property];
    return value && value !== "auto" && value !== "normal" && value !== "none"
      ? [`  ${property}: ${value}`]
      : [];
  });
  return [
    `<design_selection captured_at="${selection.capturedAt}" frame="${selection.frame}" source_version="${selection.sourceVersion}">`,
    `kind: ${selection.nodeId ? "element" : "frame"}`,
    `name: ${selection.name}`,
    ...(selection.nodeId ? [`data-oid: ${selection.nodeId}`] : []),
    `selector: ${selection.selector}`,
    `breadcrumb: ${selection.breadcrumb.join(" / ")}`,
    `rect: x=${selection.rect.x}, y=${selection.rect.y}, width=${selection.rect.width}, height=${selection.rect.height}`,
    ...(styleLines.length > 0 ? ["computed styles:", ...styleLines] : []),
    "</design_selection>",
  ].join("\n");
}

export function buildDesignSelectionAttachment(
  selection: DesignSelectionContext,
  options: DesignSelectionAttachmentOptions = {},
): DesignSelectionAttachment {
  const blocks: ContentBlock[] = [
    { type: "text", text: formatDesignSelectionContext(selection) },
  ];
  const bubbleAttachments: AgentTextMessageAttachment[] = [
    {
      name: selection.nodeId
        ? `Selection · ${selection.name}`
        : `Frame · ${selection.frame}`,
      mimeType: "application/vnd.zeros.design-selection+json",
      kind: "text",
    },
  ];
  if (options.includeImage !== false && selection.screenshotDataUrl) {
    const match = /^data:([^;]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(
      selection.screenshotDataUrl,
    );
    if (match) {
      blocks.push({
        type: "image",
        mimeType: match[1],
        data: match[2],
      });
      bubbleAttachments.push({
        name: selection.nodeId
          ? `${selection.frame} · ${selection.name}.png`
          : `${selection.frame}.png`,
        mimeType: match[1],
        kind: "image",
        thumbnailUri: selection.screenshotDataUrl,
      });
    }
  }
  return { blocks, bubbleAttachments };
}
