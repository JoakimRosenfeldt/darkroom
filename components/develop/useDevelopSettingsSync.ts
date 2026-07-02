"use client";

import { useEffect, useRef } from "react";
import type { EntryMetadata } from "@/lib/catalog/types";
import type { LibraryEntry } from "@/lib/fs/types";
import { createDevelopSettings } from "@/lib/develop/registry";
import { readDevelopSidecar, writeDevelopSidecar } from "@/lib/develop/sidecar";
import { useDevelopStore } from "@/stores/develop-store";

const PERSIST_DEBOUNCE_MS = 500;

interface UseDevelopSettingsSyncOptions {
  entry: LibraryEntry;
  rootPath: string | null;
  metadata: EntryMetadata;
  applyMetadata: (patch: Partial<EntryMetadata>) => void;
}

export function useDevelopSettingsSync({
  entry,
  rootPath,
  metadata,
  applyMetadata,
}: UseDevelopSettingsSyncOptions): void {
  const settings = useDevelopStore((state) => state.settings);
  const activeEntryId = useDevelopStore((state) => state.activeEntryId);
  const setActiveEntry = useDevelopStore((state) => state.setActiveEntry);
  const setSidecarStatus = useDevelopStore((state) => state.setSidecarStatus);
  const hydratedEntryId = useRef<string | null>(null);
  const skipNextPersist = useRef(false);

  useEffect(() => {
    let active = true;
    skipNextPersist.current = true;
    hydratedEntryId.current = null;
    setActiveEntry(entry.id, metadata.develop);

    async function hydrateFromSidecar() {
      if (!rootPath) {
        hydratedEntryId.current = entry.id;
        return;
      }

      setSidecarStatus("loading");
      try {
        const sidecar = await readDevelopSidecar(rootPath, entry.relativePath);
        if (!active) {
          return;
        }

        if (sidecar && sidecar.lastModified > metadata.updatedAt) {
          const nextMetadata: Partial<EntryMetadata> = {
            develop: sidecar.settings,
          };
          if (sidecar.rating !== undefined) {
            nextMetadata.rating = sidecar.rating;
          }
          if (sidecar.colorLabel !== undefined) {
            nextMetadata.colorLabel = sidecar.colorLabel;
          }
          skipNextPersist.current = true;
          setActiveEntry(entry.id, sidecar.settings);
          applyMetadata(nextMetadata);
        }

        setSidecarStatus("saved");
      } catch (error) {
        if (active) {
          setSidecarStatus(
            "error",
            error instanceof Error ? error.message : "Could not read XMP sidecar.",
          );
        }
      } finally {
        if (active) {
          hydratedEntryId.current = entry.id;
        }
      }
    }

    void hydrateFromSidecar();

    return () => {
      active = false;
    };
  }, [
    entry.id,
    entry.relativePath,
    rootPath,
    metadata.develop,
    metadata.updatedAt,
    metadata.rating,
    metadata.colorLabel,
    applyMetadata,
    setActiveEntry,
    setSidecarStatus,
  ]);

  useEffect(() => {
    if (activeEntryId !== entry.id || hydratedEntryId.current !== entry.id) {
      return;
    }

    if (skipNextPersist.current) {
      skipNextPersist.current = false;
      return;
    }

    const timer = window.setTimeout(() => {
      const develop = createDevelopSettings(settings);
      applyMetadata({ develop });

      if (!rootPath) {
        return;
      }

      setSidecarStatus("saving");
      void writeDevelopSidecar(rootPath, entry.relativePath, develop, metadata)
        .then(() => setSidecarStatus("saved"))
        .catch((error) => {
          setSidecarStatus(
            "error",
            error instanceof Error
              ? error.message
              : "Could not write XMP sidecar.",
          );
        });
    }, PERSIST_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [
    activeEntryId,
    entry.id,
    entry.relativePath,
    rootPath,
    settings,
    metadata,
    applyMetadata,
    setSidecarStatus,
  ]);
}
