"use client";

import { formatMetadataValue } from "@/lib/raw/utils";

interface MetadataPanelProps {
  metadata: Record<string, unknown>;
}

const PRIORITY_FIELDS = [
  "camera_make",
  "camera_model",
  "iso_speed",
  "shutter",
  "aperture",
  "focal_len",
  "timestamp",
  "width",
  "height",
  "artist",
  "desc",
  "software",
];

export function MetadataPanel({ metadata }: MetadataPanelProps) {
  const priorityEntries = PRIORITY_FIELDS.flatMap((field) => {
    if (!(field in metadata)) {
      return [];
    }
    return [[field, metadata[field]] as const];
  });

  const remainingEntries = Object.entries(metadata).filter(
    ([field]) => !PRIORITY_FIELDS.includes(field),
  );

  return (
    <aside className="flex h-full flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950">
      <div className="border-b border-zinc-800 px-4 py-3">
        <h2 className="text-sm font-medium uppercase tracking-[0.2em] text-zinc-400">
          Metadata
        </h2>
      </div>
      <div className="flex-1 space-y-4 overflow-auto p-4">
        <MetadataSection title="Capture" entries={priorityEntries} />
        <MetadataSection title="All fields" entries={remainingEntries} />
      </div>
    </aside>
  );
}

function MetadataSection({
  title,
  entries,
}: {
  title: string;
  entries: Array<readonly [string, unknown]>;
}) {
  if (entries.length === 0) {
    return null;
  }

  return (
    <section>
      <h3 className="mb-2 text-xs font-medium uppercase tracking-[0.18em] text-zinc-500">
        {title}
      </h3>
      <dl className="space-y-2">
        {entries.map(([field, value]) => (
          <div key={field} className="rounded-lg bg-zinc-900/70 px-3 py-2">
            <dt className="text-[11px] uppercase tracking-wide text-zinc-500">
              {field.replaceAll("_", " ")}
            </dt>
            <dd className="mt-1 whitespace-pre-wrap break-words text-sm text-zinc-200">
              {formatMetadataValue(value)}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
