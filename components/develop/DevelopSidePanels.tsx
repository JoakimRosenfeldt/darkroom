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
  onResetAll: () => void;
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
  onResetAll,
  onCropChange,
  onCropReset,
  onCropApply,
  onCropCancel,
}: DevelopSidePanelsProps) {
  return (
    <>
      {activePanel === "crop" ? (
        <aside className="flex w-[352px] shrink-0 flex-col border-l border-lr-border-subtle bg-lr-panel">
          <div className="flex-1 overflow-auto">
            <CropPanel
              crop={cropDraft}
              active
              imageWidth={decoded.width}
              imageHeight={decoded.height}
              onChange={onCropChange}
              onReset={onCropReset}
              onApply={onCropApply}
              onCancel={onCropCancel}
            />
          </div>
        </aside>
      ) : activePanel === "info" ? (
        <MetadataPanel
          metadata={decoded.metadata}
          fileName={entry.name}
          profileId={entry.profileId}
        />
      ) : (
        <EditPanel onResetAll={onResetAll} />
      )}
      <DevelopPanelRail activePanel={activePanel} onSelect={onSelect} />
    </>
  );
}
