"use client";

import { IconCopy, IconCrop, IconInfo, IconMask, IconRotate, IconSliders } from "@/components/shell/icons";

export type DevelopPanelId = "crop" | "edit" | "masking" | "cleanup" | "history" | "info";

interface DevelopPanelRailProps {
  activePanel: DevelopPanelId | null;
  onSelect: (panel: DevelopPanelId) => void;
  editingDisabled?: boolean;
}

const PANELS: Array<{ id: DevelopPanelId; label: string; short: string; icon: typeof IconSliders }> = [
  { id: "crop", label: "Crop", short: "CRP", icon: IconCrop },
  { id: "edit", label: "Edit", short: "EDT", icon: IconSliders },
  { id: "masking", label: "Masking", short: "MSK", icon: IconMask },
  { id: "cleanup", label: "Cleanup", short: "CLN", icon: IconCopy },
  { id: "history", label: "History", short: "HST", icon: IconRotate },
  { id: "info", label: "Info", short: "NFO", icon: IconInfo },
];

export function DevelopPanelRail({
  activePanel,
  onSelect,
  editingDisabled = false,
}: DevelopPanelRailProps) {
  return (
    <nav
      className="flex w-14 shrink-0 flex-col items-center gap-1.5 border-l border-lr-border-subtle bg-lr-panel py-3"
      aria-label="Develop panels"
    >
      {PANELS.map(({ id, label, short, icon: Icon }) => {
        const isActive = activePanel === id;
        const disabled = editingDisabled && id !== "info" && id !== "history";
        return (
          <button
            key={id}
            type="button"
            title={label}
            aria-label={label}
            aria-pressed={isActive}
            disabled={disabled}
            onClick={() => onSelect(id)}
            className={[
              "flex h-10 w-10 flex-col items-center justify-center gap-0.5 rounded-[9px] text-[8px] tracking-[0.06em] transition",
              disabled
                ? "cursor-not-allowed text-lr-text-faint opacity-40"
                : isActive
                ? "bg-lr-panel-raised text-lr-text"
                : "text-lr-text-dim hover:bg-lr-panel-raised hover:text-lr-text-muted",
            ].join(" ")}
          >
            <Icon className="h-[15px] w-[15px]" />
            <span aria-hidden="true">{short}</span>
          </button>
        );
      })}
    </nav>
  );
}
