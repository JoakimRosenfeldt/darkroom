"use client";

import Link from "next/link";
import { IconGrid, IconSliders } from "@/components/shell/icons";
import { useLibraryStore } from "@/stores/library-store";

type Module = "library" | "develop";

interface ModuleSpineProps {
  activeModule?: Module;
  developPhotoId?: string;
}

export function ModuleSpine({
  activeModule = "library",
  developPhotoId,
}: ModuleSpineProps) {
  const entries = useLibraryStore((state) => state.entries);
  const selectedEntryId = useLibraryStore((state) => state.selectedEntryId);
  const needsFolderAccess = useLibraryStore((state) => state.needsFolderAccess);
  const hasPhotos = entries.length > 0 && !needsFolderAccess;
  const developTargetId = developPhotoId ?? selectedEntryId ?? entries[0]?.id;
  const developHref = developTargetId
    ? `/photo?id=${encodeURIComponent(developTargetId)}`
    : "/photo";

  const modules = [
    {
      id: "library" as const,
      label: "LIB",
      title: "Library",
      href: "/",
      enabled: true,
      icon: IconGrid,
    },
    {
      id: "develop" as const,
      label: "DEV",
      title: "Develop",
      href: developHref,
      enabled: hasPhotos,
      icon: IconSliders,
    },
  ];

  return (
    <nav
      className="flex w-16 shrink-0 flex-col items-center gap-2 border-r border-lr-border-subtle bg-lr-panel py-3.5"
      aria-label="Modules"
    >
      <Link
        href="/"
        className="mb-2 flex h-7 w-7 items-center justify-center"
        aria-label="Darkroom library"
      >
        <span
          className="h-3 w-3 rounded-[3px] bg-lr-accent"
          aria-hidden="true"
        />
      </Link>

      {modules.map((module) => {
        const Icon = module.icon;
        const isActive = module.id === activeModule;
        const className = [
          "flex h-11 w-11 flex-col items-center justify-center gap-[3px] rounded-[10px] text-[9px] font-medium tracking-[0.04em] transition-colors",
          isActive
            ? "bg-lr-selection text-lr-accent"
            : module.enabled
              ? "text-lr-text-dim hover:bg-lr-panel-raised hover:text-lr-text"
              : "cursor-not-allowed text-lr-text-faint opacity-45",
        ].join(" ");

        const content = (
          <>
            <Icon className="h-4 w-4" />
            <span>{module.label}</span>
          </>
        );

        return module.enabled ? (
          <Link
            key={module.id}
            href={module.href}
            className={className}
            title={module.title}
            aria-current={isActive ? "page" : undefined}
          >
            {content}
          </Link>
        ) : (
          <span
            key={module.id}
            className={className}
            title="Import a folder to open Develop"
            aria-disabled="true"
          >
            {content}
          </span>
        );
      })}

    </nav>
  );
}
