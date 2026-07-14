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

interface DevelopSidePanelsProps {
  decoded: DevelopImage;
  entry: LibraryEntry;
  activePanel: DevelopPanelId | null;
  onSelect: (panel: DevelopPanelId) => void;
}

export function DevelopSidePanels({
  decoded,
  entry,
  activePanel,
  onSelect,
}: DevelopSidePanelsProps) {
  return (
    <>
      {activePanel === "crop" ? (
        <CropPanel
          imageWidth={decoded.width}
          imageHeight={decoded.height}
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
