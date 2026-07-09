"use client";

import { useEffect, useRef, useState } from "react";
import type { EntryMetadata } from "@/lib/catalog/types";
import type { LibraryEntry } from "@/lib/fs/types";
import {
  createDevelopSettings,
  developSettingsHash,
} from "@/lib/develop/registry";
import { readDevelopSidecar, writeDevelopSidecar } from "@/lib/develop/sidecar";
import { useDevelopStore } from "@/stores/develop-store";

const PERSIST_DEBOUNCE_MS = 500;

interface UseDevelopSettingsSyncOptions {
  entry: LibraryEntry;
  rootPath: string | null;
  metadata: EntryMetadata;
  applyMetadata: (patch: Partial<EntryMetadata>) => void;
}

interface PendingPersist {
  entryId: string;
  timer: number;
  flush: () => void;
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
  const metadataRef = useRef(metadata);
  const pendingPersistRef = useRef<PendingPersist | null>(null);
  const [hydrationVersion, setHydrationVersion] = useState(0);

  useEffect(() => {
    metadataRef.current = metadata;
  }, [metadata]);

  useEffect(() => {
    let active = true;
    skipNextPersist.current = true;
    hydratedEntryId.current = null;
    setActiveEntry(entry.id, metadataRef.current.develop);
    const hydrationStartHash = developSettingsHash(
      useDevelopStore.getState().settings,
    );

    async function hydrateFromSidecar() {
      if (!rootPath) {
        if (
          developSettingsHash(useDevelopStore.getState().settings) !==
          hydrationStartHash
        ) {
          skipNextPersist.current = false;
        }
        hydratedEntryId.current = entry.id;
        setHydrationVersion((version) => version + 1);
        return;
      }

      setSidecarStatus("loading");
      try {
        const sidecar = await readDevelopSidecar(rootPath, entry.relativePath);
        if (!active) {
          return;
        }

        const hasLocalEdits =
          developSettingsHash(useDevelopStore.getState().settings) !==
          hydrationStartHash;
        if (
          sidecar &&
          !hasLocalEdits &&
          sidecar.lastModified > metadataRef.current.updatedAt
        ) {
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
        } else if (hasLocalEdits) {
          skipNextPersist.current = false;
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
          setHydrationVersion((version) => version + 1);
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
    applyMetadata,
    setActiveEntry,
    setSidecarStatus,
  ]);

  useEffect(() => {
    return () => {
      const pending = pendingPersistRef.current;
      if (pending?.entryId !== entry.id) {
        return;
      }

      window.clearTimeout(pending.timer);
      pendingPersistRef.current = null;
      pending.flush();
    };
  }, [entry.id]);

  useEffect(() => {
    if (activeEntryId !== entry.id || hydratedEntryId.current !== entry.id) {
      return;
    }

    if (skipNextPersist.current) {
      skipNextPersist.current = false;
      return;
    }

    const persist = () => {
      const develop = createDevelopSettings(settings);
      applyMetadata({ develop });

      if (!rootPath) {
        return;
      }

      const setStatusForEntry = (
        status: Parameters<typeof setSidecarStatus>[0],
        error?: string | null,
      ) => {
        if (useDevelopStore.getState().activeEntryId === entry.id) {
          setSidecarStatus(status, error);
        }
      };

      setStatusForEntry("saving");
      void writeDevelopSidecar(
        rootPath,
        entry.relativePath,
        develop,
        { rating: metadata.rating, colorLabel: metadata.colorLabel },
      )
        .then(() => setStatusForEntry("saved"))
        .catch((error) => {
          setStatusForEntry(
            "error",
            error instanceof Error
              ? error.message
              : "Could not write XMP sidecar.",
          );
        });
    };
    const pending: PendingPersist = {
      entryId: entry.id,
      timer: 0,
      flush: persist,
    };
    pending.timer = window.setTimeout(() => {
      if (pendingPersistRef.current === pending) {
        pendingPersistRef.current = null;
      }
      persist();
    }, PERSIST_DEBOUNCE_MS);
    pendingPersistRef.current = pending;

    return () => {
      window.clearTimeout(pending.timer);
      if (pendingPersistRef.current === pending) {
        pendingPersistRef.current = null;
      }
    };
  }, [
    activeEntryId,
    entry.id,
    entry.relativePath,
    hydrationVersion,
    rootPath,
    settings,
    metadata.rating,
    metadata.colorLabel,
    applyMetadata,
    setSidecarStatus,
  ]);
}
