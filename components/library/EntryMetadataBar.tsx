"use client";

import {
  COLOR_LABEL_HEX,
  getEntryMetadata,
} from "@/lib/catalog/defaults";
import type { EntryMetadata } from "@/lib/catalog/types";
import { COLOR_LABELS } from "@/lib/catalog/types";
import { StarRatingControl } from "@/components/library/StarRatingControl";
import { useLibraryStore } from "@/stores/library-store";

interface EntryMetadataBadgesProps {
  metadata: EntryMetadata;
}

export function EntryMetadataBadges({
  metadata,
}: EntryMetadataBadgesProps) {
  const { pick, colorLabel } = metadata;
  const showPick = pick === "pick";

  return (
    <>
      {colorLabel ? (
        <span
          className="pointer-events-none absolute left-2 top-2 h-2 w-2 rounded-[2px] shadow-[0_0_0_1.5px_rgba(15,13,12,.7)]"
          style={{ backgroundColor: COLOR_LABEL_HEX[colorLabel] }}
        />
      ) : null}

      {showPick || metadata.pick === "reject" ? (
        <span
          className={[
            "pointer-events-none absolute left-5 top-1.5 rounded-[4px] bg-[#0f0d0c]/80 px-1.5 py-0.5 font-mono text-[9px]",
            showPick ? "text-[#8fd0a0]" : "text-lr-danger",
          ].join(" ")}
        >
          {showPick ? "PICK" : "REJ"}
        </span>
      ) : null}

      {metadata.rating > 0 ? (
        <span className="pointer-events-none absolute right-2 top-1.5 rounded-[4px] bg-[#0f0d0c]/80 px-1.5 py-0.5 font-mono text-[9px] text-lr-accent">
          {metadata.rating}★
        </span>
      ) : null}
    </>
  );
}

interface EntryMetadataBarProps {
  entryId: string;
  metadata: EntryMetadata;
  onPick: () => void;
  onReject: () => void;
  onClearPick: () => void;
  onRating: (rating: EntryMetadata["rating"]) => void;
  onColorLabel: (label: (typeof COLOR_LABELS)[number]) => void;
}

export function EntryMetadataBar({
  metadata,
  onPick,
  onReject,
  onClearPick,
  onRating,
  onColorLabel,
}: EntryMetadataBarProps) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-3 border-t border-lr-border-subtle bg-lr-toolbar px-4">
      <div className="flex items-center gap-1">
        <MetadataButton
          active={metadata.pick === "pick"}
          onClick={onPick}
          title="Pick (P)"
        >
          <span className="text-[11px]">Pick</span>
        </MetadataButton>
        <MetadataButton
          active={metadata.pick === "reject"}
          onClick={onReject}
          title="Reject (X)"
        >
          <span className="text-[11px]">Reject</span>
        </MetadataButton>
        <MetadataButton
          active={metadata.pick === "none"}
          onClick={onClearPick}
          title="Clear pick (U)"
        >
          <span className="text-[11px]">Unflagged</span>
        </MetadataButton>
      </div>

      <div className="h-5 w-px bg-lr-border-subtle" />

      <StarRatingControl
        value={metadata.rating}
        onChange={onRating}
      />

      <div className="h-5 w-px bg-lr-border-subtle" />

      <div className="flex items-center gap-1.5">
        {COLOR_LABELS.map((label) => (
          <button
            key={label}
            type="button"
            onClick={() => onColorLabel(label)}
            title={`${label} label`}
            className={[
              "h-3.5 w-3.5 rounded-[4px] border transition",
              metadata.colorLabel === label
                ? "border-white/80 ring-1 ring-white/40"
                : "border-transparent opacity-70 hover:opacity-100",
            ].join(" ")}
            style={{ backgroundColor: COLOR_LABEL_HEX[label] }}
          />
        ))}
      </div>
    </div>
  );
}

function MetadataButton({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={[
        "rounded-md px-2.5 py-1.5 transition",
        active
          ? "bg-lr-selection text-lr-text"
          : "text-lr-text-muted hover:bg-lr-panel-raised hover:text-lr-text",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

export function useEntryMetadataForId(entryId: string): EntryMetadata {
  const entryMetadata = useLibraryStore((state) => state.entryMetadata);
  return getEntryMetadata(entryMetadata, entryId);
}
