"use client";

import { formatMetadataValue } from "@/lib/raw/utils";
import { IconInfo } from "@/components/shell/icons";

interface MetadataPanelProps {
  metadata: Record<string, unknown>;
  fileName: string;
  profileId: string | null;
}

const CAPTURE_FIELDS: Array<{ key: string; label: string }> = [
  { key: "camera_make", label: "Make" },
  { key: "camera_model", label: "Model" },
  { key: "lens", label: "Lens" },
  { key: "focal_len", label: "Focal Length" },
  { key: "aperture", label: "Aperture" },
  { key: "shutter", label: "Shutter" },
  { key: "iso_speed", label: "ISO" },
  { key: "timestamp", label: "Date Time" },
];

function formatShutter(value: unknown): string {
  if (typeof value !== "number") {
    return formatMetadataValue(value);
  }
  if (value >= 1) {
    return `${value}s`;
  }
  return `1/${Math.round(1 / value)}`;
}

function formatAperture(value: unknown): string {
  if (typeof value !== "number") {
    return formatMetadataValue(value);
  }
  return `f/${value.toFixed(1)}`;
}

function formatFocal(value: unknown): string {
  if (typeof value !== "number") {
    return formatMetadataValue(value);
  }
  return `${value} mm`;
}

function formatField(key: string, value: unknown): string {
  if (key === "shutter") {
    return formatShutter(value);
  }
  if (key === "aperture") {
    return formatAperture(value);
  }
  if (key === "focal_len") {
    return formatFocal(value);
  }
  if (key === "lens" && typeof value === "object" && value !== null) {
    const lens = value as { Lens?: string };
    return lens.Lens ?? formatMetadataValue(value);
  }
  return formatMetadataValue(value);
}

export function MetadataPanel({
  metadata,
  fileName,
  profileId,
}: MetadataPanelProps) {
  const captureRows = CAPTURE_FIELDS.flatMap(({ key, label }) => {
    if (!(key in metadata)) {
      return [];
    }
    return [{ label, value: formatField(key, metadata[key]) }];
  });

  const dimensions =
    "width" in metadata && "height" in metadata
      ? `${metadata.width} × ${metadata.height}`
      : null;

  return (
    <aside className="flex w-64 shrink-0 flex-col border-l border-lr-border-subtle bg-lr-panel">
      <div className="flex items-center gap-2 border-b border-lr-border-subtle px-3 py-2">
        <IconInfo className="h-3.5 w-3.5 text-lr-text-dim" />
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-lr-text-muted">
          Metadata
        </h2>
      </div>

      <div className="flex-1 overflow-auto">
        <MetadataSection title="File">
          <MetadataRow label="File Name" value={fileName} />
          <MetadataRow label="Format" value={profileId?.toUpperCase() ?? "—"} />
          {dimensions ? (
            <MetadataRow label="Dimensions" value={dimensions} />
          ) : null}
        </MetadataSection>

        {captureRows.length > 0 ? (
          <MetadataSection title="Capture">
            {captureRows.map((row) => (
              <MetadataRow key={row.label} label={row.label} value={row.value} />
            ))}
          </MetadataSection>
        ) : null}

        <MetadataSection title="All Metadata" defaultOpen={false}>
          {Object.entries(metadata).map(([key, value]) => (
            <MetadataRow
              key={key}
              label={key.replaceAll("_", " ")}
              value={formatMetadataValue(value)}
              mono
            />
          ))}
        </MetadataSection>
      </div>
    </aside>
  );
}

function MetadataSection({
  title,
  children,
  defaultOpen = true,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details open={defaultOpen} className="border-b border-lr-border-subtle">
      <summary className="cursor-pointer select-none px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-lr-text-dim hover:text-lr-text-muted">
        {title}
      </summary>
      <dl className="px-3 pb-2">{children}</dl>
    </details>
  );
}

function MetadataRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="grid grid-cols-[88px_1fr] gap-2 py-1 text-xs">
      <dt className="text-lr-text-dim">{label}</dt>
      <dd
        className={[
          "break-words text-lr-text",
          mono ? "font-mono text-[10px] leading-relaxed" : "",
        ].join(" ")}
      >
        {value}
      </dd>
    </div>
  );
}
