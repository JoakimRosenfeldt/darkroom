"use client";

import { useEffect, useRef } from "react";
import type { EntryMetadata } from "@/lib/catalog/types";
import type { LibraryEntry } from "@/lib/fs/types";
import { createDevelopSettings, developSettingsHash } from "@/lib/develop/registry";
import type { DevelopSettings } from "@/lib/develop/types";
import { readDevelopSidecar, writeDevelopSidecar } from "@/lib/develop/sidecar";
import { useDevelopStore } from "@/stores/develop-store";

const PERSIST_DEBOUNCE_MS = 500;

interface UseDevelopSettingsSyncOptions {
  entry: LibraryEntry;
  rootPath: string | null;
  metadata: EntryMetadata;
  applyMetadata: (patch: Partial<EntryMetadata>) => void;
}

function snapshot(
  settings: DevelopSettings,
  metadata: Pick<EntryMetadata, "rating" | "colorLabel">,
): string {
  return JSON.stringify({
    settings,
    rating: metadata.rating,
    colorLabel: metadata.colorLabel,
  });
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
  const sidecarStatus = useDevelopStore((state) => state.sidecarStatus);
  const metadataRef = useRef(metadata);
  const persistedSnapshotRef = useRef<string | null>(null);
  const sidecarContentsRef = useRef<{ entryId: string; contents: string | null }>({
    entryId: "",
    contents: null,
  });
  const pendingWriteRef = useRef<Promise<void>>(Promise.resolve());
  const hydratedEntryIdRef = useRef<string | null>(null);
  const canWriteSidecarRef = useRef(true);

  useEffect(() => {
    metadataRef.current = metadata;
  }, [metadata]);

  useEffect(() => {
    let active = true;
    hydratedEntryIdRef.current = null;
    setActiveEntry(entry.id, metadataRef.current.develop);
    setSidecarStatus("loading");
    const initialSettings = useDevelopStore.getState().settings;
    const initialSnapshot = snapshot(initialSettings, metadataRef.current);
    sidecarContentsRef.current = { entryId: entry.id, contents: null };
    canWriteSidecarRef.current = true;

    async function hydrate(): Promise<void> {
      let sidecarContents: string | null = null;
      let persisted = initialSnapshot;

      try {
        if (rootPath) {
          const sidecar = await readDevelopSidecar(rootPath, entry.relativePath);
          if (!active) {
            return;
          }
          sidecarContents = sidecar?.contents ?? null;

          const hasLocalChanges =
            developSettingsHash(useDevelopStore.getState().settings) !==
            developSettingsHash(initialSettings);
          if (
            sidecar &&
            !hasLocalChanges &&
            sidecar.lastModified > metadataRef.current.updatedAt
          ) {
            const nextMetadata: Partial<EntryMetadata> = {
              develop: sidecar.settings,
              ...(sidecar.rating === undefined ? {} : { rating: sidecar.rating }),
              ...(sidecar.colorLabel === undefined
                ? {}
                : { colorLabel: sidecar.colorLabel }),
            };
            setActiveEntry(entry.id, sidecar.settings);
            applyMetadata(nextMetadata);
            persisted = snapshot(sidecar.settings, {
              rating: sidecar.rating ?? metadataRef.current.rating,
              colorLabel: sidecar.colorLabel ?? metadataRef.current.colorLabel,
            });
          } else {
            const currentSnapshot = snapshot(
              useDevelopStore.getState().settings,
              metadataRef.current,
            );
            persisted = currentSnapshot === initialSnapshot
              ? currentSnapshot
              : initialSnapshot;
          }
        }

        if (active) {
          sidecarContentsRef.current = { entryId: entry.id, contents: sidecarContents };
          persistedSnapshotRef.current = persisted;
          setSidecarStatus("saved");
        }
      } catch (error) {
        if (active) {
          canWriteSidecarRef.current = false;
          setSidecarStatus(
            "error",
            error instanceof Error ? error.message : "Could not read XMP sidecar.",
          );
          persistedSnapshotRef.current = null;
        }
      } finally {
        if (active) {
          hydratedEntryIdRef.current = entry.id;
        }
      }
    }

    void hydrate();
    return () => {
      active = false;
    };
  }, [
    entry.id,
    entry.relativePath,
    rootPath,
    applyMetadata,
    setActiveEntry,
    setSidecarStatus,
  ]);

  useEffect(() => {
    if (
      activeEntryId !== entry.id ||
      hydratedEntryIdRef.current !== entry.id
    ) {
      return;
    }

    const nextSnapshot = snapshot(settings, metadata);
    if (nextSnapshot === persistedSnapshotRef.current) {
      return;
    }
    if (rootPath && !canWriteSidecarRef.current) {
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      const develop = createDevelopSettings(settings);
      applyMetadata({ develop });

      if (!rootPath) {
        persistedSnapshotRef.current = nextSnapshot;
        return;
      }

      setSidecarStatus("saving");
      const write = async (): Promise<void> => {
        if (cancelled) {
          return;
        }
        const sidecar = sidecarContentsRef.current;
        const contents = await writeDevelopSidecar(
          rootPath,
          entry.relativePath,
          develop,
          metadata,
          sidecar.entryId === entry.id ? sidecar.contents : null,
        );
        sidecarContentsRef.current = { entryId: entry.id, contents };
        if (
          useDevelopStore.getState().activeEntryId === entry.id &&
          snapshot(useDevelopStore.getState().settings, metadataRef.current) ===
            nextSnapshot
        ) {
          persistedSnapshotRef.current = nextSnapshot;
          setSidecarStatus("saved");
        }
      };

      const queued = pendingWriteRef.current.then(write, write);
      pendingWriteRef.current = queued.catch(() => undefined);
      void queued.catch((error) => {
        if (!cancelled) {
          setSidecarStatus(
            "error",
            error instanceof Error ? error.message : "Could not write XMP sidecar.",
          );
        }
      });
    }, PERSIST_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    activeEntryId,
    entry.id,
    entry.relativePath,
    metadata,
    rootPath,
    sidecarStatus,
    settings,
    applyMetadata,
    setSidecarStatus,
  ]);
}
