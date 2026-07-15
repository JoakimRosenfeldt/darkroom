"use client";

import type { LibraryEntry } from "@/lib/fs/types";
import type { DevelopImage } from "@/lib/cache/develop-image-cache";
import { CropPanel } from "@/components/develop/CropPanel";
import { EditPanel } from "@/components/develop/EditPanel";
import {
  DevelopPanelRail,
  type DevelopPanelId,
} from "@/components/develop/DevelopPanelRail";
import { MetadataPanel } from "@/components/viewer/MetadataPanel";
import type { CropSettings } from "@/lib/develop/types";

interface DevelopSidePanelsProps {
  decoded: DevelopImage;
  entry: LibraryEntry;
  activePanel: DevelopPanelId | null;
  cropDraft: CropSettings | null;
  onSelect: (panel: DevelopPanelId) => void;
  onCropChange: (crop: CropSettings, preserveFrame?: boolean) => void;
  onCropReset: () => void;
  onCropApply: () => void;
  onCropCancel: () => void;
}

export function DevelopSidePanels({
  decoded,
  entry,
  activePanel,
  cropDraft,
  onSelect,
  onCropChange,
  onCropReset,
  onCropApply,
  onCropCancel,
}: DevelopSidePanelsProps) {
  return (
    <>
      {activePanel === "crop" && cropDraft ? (
        <CropPanel
          crop={cropDraft}
          imageWidth={decoded.width}
          imageHeight={decoded.height}
          onChange={onCropChange}
          onReset={onCropReset}
          onApply={onCropApply}
          onCancel={onCropCancel}
        />
      ) : null}
      {activePanel === "edit" ? <EditPanel /> : null}
      {activePanel === "info" ? (
        <MetadataPanel
          metadata={decoded.metadata}
          fileName={entry.name}
          profileId={entry.profileId}
        />
      ) : null}
      <DevelopPanelRail activePanel={activePanel} onSelect={onSelect} />
    </>
  );
}
