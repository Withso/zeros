import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { ImagePlus } from "lucide-react";
import { Input, toast } from "../../shared/ui/primitives";
import { getActiveBridge } from "../../platform/bridge/active-bridge";
import { isCloudWorkspace, parseCloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";
import type {
  CloudDesignAssetUploadInput,
  DesignCanvasFrameWire,
} from "../../platform/bridge/design-bridge";
import {
  cloudWorkspaceCanEdit,
  useCloudWorkspaceCanEdit,
} from "../../state/use-cloud-workspace-can-edit";
import { useCloudWorkspaceAccountAccess } from "../team/cloud-workspace-account-access";
import { DesignToolbarButton } from "./design-inspector-kit";
import { uploadDesignAssetCached } from "./state/design-workspace-cache";
import { useDesignWorkspaceUiStore } from "./state/design-workspace-ui";

const types: Record<string, CloudDesignAssetUploadInput["mimeType"]> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
};
export function CloudDesignImageUpload({
  workspaceId,
  directoryId,
  frame,
  active,
}: {
  workspaceId: string | null | undefined;
  directoryId: string | undefined;
  frame: DesignCanvasFrameWire | null;
  active: boolean;
}) {
  const enabled = useCloudWorkspaceAccountAccess(parseCloudWorkspaceKey(workspaceId)?.organizationId);
  const canEdit = useCloudWorkspaceCanEdit(workspaceId ?? undefined);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const owner = useMemo(
    () => ({
      workspaceId,
      directoryId,
      file: frame?.file,
      frameId: frame?.frameId,
      active,
      enabled,
      canEdit,
    }),
    [
      workspaceId,
      directoryId,
      frame?.file,
      frame?.frameId,
      active,
      enabled,
      canEdit,
    ],
  );
  const current = useRef<typeof owner | null>(owner);
  current.current = owner;
  useLayoutEffect(() => {
    current.current = owner;
    return () => {
      current.current = null;
    };
  }, [owner]);
  const picker = useRef<{
    owner: typeof owner;
    bridge: ReturnType<typeof getActiveBridge>;
  } | null>(null);
  if (!isCloudWorkspace(workspaceId) || !enabled) return null;
  const disabled = !active || !canEdit || !directoryId || !frame || busy;
  const upload = async (file: File) => {
    const picked = picker.current;
    picker.current = null;
    if (
      !picked ||
      picked.owner !== owner ||
      disabled ||
      !workspaceId ||
      !directoryId ||
      !frame ||
      running.current
    )
      return;
    running.current = true;
    setBusy(true);
    try {
      const mimeType = types[file.name.split(".").at(-1)?.toLowerCase() ?? ""];
      if (
        !mimeType ||
        (file.type && file.type !== mimeType) ||
        !file.size ||
        file.size > 10 * 1024 * 1024
      ) {
        toast.error("Couldn't upload image", {
          description:
            "Choose a PNG, JPEG, GIF, WebP or AVIF image of at most 10 MiB.",
        });
        return;
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (
        current.current !== picked.owner ||
        getActiveBridge() !== picked.bridge ||
        !cloudWorkspaceCanEdit(workspaceId) ||
        useDesignWorkspaceUiStore.getState().byWorkspace[workspaceId]
          ?.directoryId !== directoryId
      )
        return;
      const chunks: string[] = [];
      for (let offset = 0; offset < bytes.length; offset += 8192)
        chunks.push(
          String.fromCharCode(...bytes.subarray(offset, offset + 8192)),
        );
      await uploadDesignAssetCached(workspaceId, {
        directoryId,
        frame: frame.file,
        sourceVersion: frame.sourceVersion,
        name: file.name,
        mimeType,
        data: btoa(chunks.join("")),
        x: 16,
        y: 16,
      });
    } catch {
      // Transport failures can include commands, VM paths or image bytes. Keep
      // diagnostics closed, and do not replay a possibly committed insertion.
      console.warn("Cloud Design image upload failed", {
        reason: "upload_failed",
      });
      if (current.current === picked.owner)
        toast.error("Couldn't upload image", {
          description: "Check the canvas before trying again.",
        });
    } finally {
      running.current = false;
      if (current.current) setBusy(false);
    }
  };
  return (
    <>
      <DesignToolbarButton
        label="Upload image"
        tooltip={busy ? "Uploading image…" : "Upload image"}
        tooltipSide="right"
        disabled={disabled}
        onClick={() => {
          picker.current = { owner, bridge: getActiveBridge() };
          input.current?.click();
        }}
      >
        <ImagePlus />
      </DesignToolbarButton>
      <Input
        ref={input}
        className="hidden"
        type="file"
        tabIndex={-1}
        aria-label="Design image file"
        accept=".png,.jpg,.jpeg,.gif,.webp,.avif"
        disabled={disabled}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) void upload(file);
        }}
      />
    </>
  );
}
