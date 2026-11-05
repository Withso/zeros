import { describe, expect, it } from "vitest";

import { designFrameResizeRootGeometry } from "../design-auto-layout-values";
import {
  designOverlayCounterTransform,
  designResizeHandleCursor,
  designRotatedOverlayFrame,
  designRotatedResizeOrigin,
  designRotationCornerCursorAngle,
  designSelectionBox,
  designSelectionBoxCorners,
  designSelectionLabelPlacement,
  designSelectionLocalDelta,
  designSelectionOverlayFrame,
  designSelectionPivot,
  designTranslatedNodeGeometry,
  type DesignSelectionBox,
} from "../design-canvas-math";
import { designLocalAxisDelta } from "../design-layout-tools";
import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";

/** What the frame runtime reports for a 100 × 60 layer at (40, 20) whose own
 * CSS mirrors its x axis about its centre (`scale: -1 1`). Its painted box is
 * still (40, 20, 100, 60); the runtime describes it as a half turn with a
 * flipped local y axis and flipped origin, plus the real coordinate space. */
const mirrored = {
  rect: { x: 40, y: 20, width: 100, height: 60 },
  box: {
    x: 140,
    y: 80,
    width: 100,
    height: 60,
    rotation: 180,
    scaleX: 1,
    scaleY: 1,
    originX: 0.5,
    originY: 0.25,
  },
  borderCoordinateSpace: [-1, 0, 0, 1, 140, 20] as [
    number,
    number,
    number,
    number,
    number,
    number,
  ],
};

describe("selection chrome for transformed layers", () => {
  it("keeps a mirrored layer's own axes so its handles resize the edges they sit on", () => {
    const box = designSelectionBox(mirrored);
    expect(box.affine).toEqual([-1, 0, 0, 1]);
    expect(box).toMatchObject({ x: 140, y: 20, originY: 0.75 });
    // nw, ne, se, sw of the element itself: its local top-left is painted at
    // the right, its top edge still on top.
    expect(designSelectionBoxCorners(box)).toEqual([
      { x: 140, y: 20 },
      { x: 40, y: 20 },
      { x: 40, y: 80 },
      { x: 140, y: 80 },
    ]);
    expect(designSelectionPivot(box)).toEqual({ x: 90, y: 65 });
    // Pointer travel to the right is travel toward the element's own left.
    expect(designSelectionLocalDelta({ x: 10, y: 5 }, box)).toEqual({ x: -10, y: 5 });
  });

  it("grows a mirrored layer from the handle the pointer holds", () => {
    const box = designSelectionBox(mirrored);
    // The south-east handle (local w, h) is painted bottom-left. Dragging it
    // keeps the local north-west corner — painted top-right — still.
    const origin = designRotatedResizeOrigin({ box, anchor: { x: 0, y: 0 }, width: 130, height: 90 });
    expect(origin).toEqual({ x: 140, y: 20 });
    // Holding the opposite (south-east) corner moves the origin out with the
    // growth along the mirrored x axis and the upright y axis.
    const held = designRotatedResizeOrigin({ box, anchor: { x: 1, y: 1 }, width: 130, height: 90 });
    expect(held).toEqual({ x: 170, y: -10 });
  });

  it("reads spacing drags along a mirrored axis the way it points", () => {
    expect(
      designLocalAxisDelta({ dx: 12, dy: 0, axis: "x", rotation: 180, linear: [-1, 0, 0, 1], zoom: 2 }),
    ).toBe(-6);
    expect(
      designLocalAxisDelta({ dx: 0, dy: 12, axis: "y", rotation: 180, linear: [-1, 0, 0, 1], zoom: 2 }),
    ).toBe(6);
  });

  it("places the size badge upright below the edge that faces down", () => {
    const upright = designSelectionLabelPlacement({ width: 100, height: 60, rotation: 0 });
    expect(upright).toMatchObject({ left: 50, top: 60, angle: 0 });
    expect(upright.transform).toBe(
      "scale(var(--design-canvas-inverse-zoom)) translate(-50%, 4px)",
    );
    // A half turn puts the element's top edge at the bottom of the screen.
    const half = designSelectionLabelPlacement({ width: 100, height: 60, rotation: 180 });
    expect(half).toMatchObject({ left: 50, top: 0 });
    expect(Math.abs(half.angle)).toBeLessThan(1e-9);
    expect(half.transform).toBe(
      "rotate(-180deg) scale(var(--design-canvas-inverse-zoom)) translate(-50%, 4px)",
    );
    // A mirrored overlay undoes its own mirror so the text is not reversed.
    const flipped = designSelectionLabelPlacement(
      designSelectionOverlayFrame(designSelectionBox(mirrored)),
    );
    expect(flipped).toMatchObject({ left: 50, top: 60 });
    expect(flipped.transform).toBe(
      "matrix(-1,0,0,1,0,0) scale(var(--design-canvas-inverse-zoom)) translate(-50%, 4px)",
    );
    // A layer turned -66° shows its left edge lowest; the badge runs along it.
    const turned = designSelectionLabelPlacement({ width: 288, height: 270, rotation: -66 });
    expect(turned).toMatchObject({ left: 0, top: 135 });
    expect(turned.angle).toBeCloseTo(24, 6);
  });

  it("counter-transforms chrome by the overlay's whole map", () => {
    expect(designOverlayCounterTransform({ rotation: 0 })).toBe("");
    expect(designOverlayCounterTransform({ rotation: 30 })).toBe("rotate(-30deg)");
    expect(designOverlayCounterTransform({ rotation: 180, affine: [-1, 0, 0, 1] })).toBe(
      "matrix(-1,0,0,1,0,0)",
    );
  });

  it("predicts a dragged layer from its own shape, not its bounding box", () => {
    const node = {
      ...mirrored,
      box: { ...mirrored.box, rotation: -66 } satisfies DesignSelectionBox,
    };
    const moved = designTranslatedNodeGeometry(node, 30, -12);
    expect(moved.rect).toEqual({ x: 70, y: 8, width: 100, height: 60 });
    expect(moved.box).toMatchObject({ x: 170, y: 68, width: 100, height: 60, rotation: -66 });
    expect(moved.borderCoordinateSpace).toEqual([-1, 0, 0, 1, 170, 8]);
    // The source keeps its geometry: the gesture's baseline is not mutated.
    expect(node.rect.x).toBe(40);
  });

  it("turns a mirrored overlay about its pivot during a rotation", () => {
    const frame = designSelectionOverlayFrame(designSelectionBox(mirrored));
    const turned = designRotatedOverlayFrame(frame, 90);
    const pivot = (overlay: typeof frame) => ({
      x: overlay.left + overlay.affine![0] * overlay.pivotX + overlay.affine![2] * overlay.pivotY,
      y: overlay.top + overlay.affine![1] * overlay.pivotX + overlay.affine![3] * overlay.pivotY,
    });
    expect(pivot(turned).x).toBeCloseTo(pivot(frame).x, 9);
    expect(pivot(turned).y).toBeCloseTo(pivot(frame).y, 9);
    expect(turned.rotation).toBe(270);
    // An upright overlay is anchored on its pivot already.
    const upright = designRotatedOverlayFrame({ left: 1, top: 2, width: 3, height: 4, rotation: 10, pivotX: 1, pivotY: 1 }, 5);
    expect(upright).toEqual({ left: 1, top: 2, width: 3, height: 4, rotation: 15, pivotX: 1, pivotY: 1 });
  });

  it("aims each rotation cursor from where its corner sits on screen", () => {
    // Upright, the corner's screen direction reproduces the fixed table.
    expect(designRotationCornerCursorAngle({ x: 0, y: 0 }, { rotation: 0 })).toBeCloseTo(-45, 9);
    expect(designRotationCornerCursorAngle({ x: 1, y: 1 }, { rotation: 30 })).toBeCloseTo(165, 9);
    // Mirrored, the local north-west corner is painted at the north-east.
    expect(designRotationCornerCursorAngle({ x: 0, y: 0 }, { rotation: 180, affine: [-1, 0, 0, 1] })).toBeCloseTo(45, 9);
  });

  it("points each resize cursor the way its handle sits on screen", () => {
    expect(designResizeHandleCursor("nw", { rotation: 0 })).toBe("nwse-resize");
    expect(designResizeHandleCursor("nw", { rotation: 90 })).toBe("nesw-resize");
    expect(designResizeHandleCursor("e", { rotation: 90 })).toBe("ns-resize");
    expect(designResizeHandleCursor("nw", { rotation: 180, affine: [-1, 0, 0, 1] })).toBe("nesw-resize");
  });
});

describe("frame root geometry while its frame is resized", () => {
  const root = (widthValue: string, heightValue: string, rect = { x: 0, y: 0, width: 360, height: 225 }) =>
    ({
      rect,
      box: { ...rect, rotation: 0, scaleX: 1, scaleY: 1, originX: 0.5, originY: 0.5 },
      layout: { widthValue, heightValue },
    }) as unknown as DesignRuntimeNodeDetails;

  it("follows the frame on axes the root spans", () => {
    expect(designFrameResizeRootGeometry(root("100%", "100vh"), { w: 360, h: 225 }, { w: 240, h: 145 })?.rect)
      .toEqual({ x: 0, y: 0, width: 240, height: 145 });
  });

  it("follows the frame on a Hug axis the resize fixes to it", () => {
    const hug = root("max-content", "100vh", { x: 0, y: 0, width: 120, height: 225 });
    expect(designFrameResizeRootGeometry(hug, { w: 360, h: 225 }, { w: 400, h: 225 })?.rect)
      .toEqual({ x: 0, y: 0, width: 400, height: 225 });
  });

  it("keeps an axis that does not span the frame", () => {
    const fixed = root("200px", "120px", { x: 20, y: 10, width: 200, height: 120 });
    expect(designFrameResizeRootGeometry(fixed, { w: 360, h: 225 }, { w: 240, h: 145 })?.rect)
      .toEqual({ x: 20, y: 10, width: 200, height: 120 });
  });

  it("leaves a turned root to its measurement", () => {
    const turned = { ...root("100%", "100vh"), box: { ...root("100%", "100vh").box!, rotation: 30 } } as DesignRuntimeNodeDetails;
    expect(designFrameResizeRootGeometry(turned, { w: 360, h: 225 }, { w: 240, h: 145 })).toBeNull();
  });
});
