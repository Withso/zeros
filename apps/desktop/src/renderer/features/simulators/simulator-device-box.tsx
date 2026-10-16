import type { ReactNode } from "react";
import type { SimulatorDeviceFrame } from "@zeros/protocol/simulators";

import { cn } from "../../shared/ui/cn";
import {
  deviceBoxRect,
  deviceBoxSize,
  frameMask,
  framePieces,
  type BoxRect,
  type DeviceLayout,
} from "./simulator-geometry";

type FrameButton = SimulatorDeviceFrame["buttons"][number];

function placed(rect: BoxRect) {
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

function FrameImage({ url, rect }: { url: string; rect: BoxRect }) {
  return (
    <img
      src={url}
      alt=""
      draggable={false}
      className="pointer-events-none absolute select-none"
      style={placed(rect)}
    />
  );
}

/** A device at `scale` CSS pixels per point: its platform's frame when there
 * is one, else a plain bezel, with `children` on its screen. Side buttons sit
 * behind the frame, and a home button and the frame's mask over the screen,
 * as on the device. */
export function SimulatorDeviceBox({
  layout,
  frame,
  scale,
  screenClassName,
  children,
}: {
  layout: DeviceLayout;
  frame: SimulatorDeviceFrame | null;
  scale: number;
  screenClassName?: string;
  children?: ReactNode;
}) {
  const box = deviceBoxSize(layout, scale);
  const screen = deviceBoxRect(layout, scale, layout.screen);
  const screenRadius = layout.screenRadius * scale;
  const bezel = deviceBoxRect(layout, scale, {
    x: 0,
    y: 0,
    width: layout.width,
    height: layout.height,
  });
  const bezelRadius = layout.frameRadius * scale;
  const button = (entry: FrameButton, index: number) => (
    <FrameImage
      key={`${entry.name}:${index}`}
      url={entry.image.url}
      rect={deviceBoxRect(layout, scale, {
        x: entry.x,
        y: entry.y,
        width: entry.image.width,
        height: entry.image.height,
      })}
    />
  );
  const buttons = frame?.buttons ?? [];
  const mask = frame && frameMask(frame);
  return (
    <div
      data-simulator-device=""
      className="relative shrink-0"
      style={{ width: box.width, height: box.height }}
    >
      {buttons.filter((entry) => !entry.onTop).map(button)}
      {frame ? (
        framePieces(frame).map((piece) => (
          <FrameImage
            key={piece.key}
            url={piece.url}
            rect={deviceBoxRect(layout, scale, piece.rect)}
          />
        ))
      ) : (
        <div
          data-simulator-bezel=""
          aria-hidden
          className="border-border3 bg-bg2 absolute border"
          style={{ ...placed(bezel), borderRadius: bezelRadius }}
        />
      )}
      <div
        data-simulator-screen=""
        className={cn("absolute overflow-hidden", screenClassName)}
        style={{ ...placed(screen), borderRadius: screenRadius }}
      >
        {children}
      </div>
      {mask && <FrameImage url={mask.url} rect={deviceBoxRect(layout, scale, mask.rect)} />}
      {buttons.filter((entry) => entry.onTop).map(button)}
    </div>
  );
}
