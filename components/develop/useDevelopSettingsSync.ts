"use client";

import { useEffect, useRef } from "react";
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
  const sidecarSourceRef = useRef<string | null>(null);
  const sidecarWritableRef = useRef(true);
  const sidecarWritesRef = useRef(Promise.resolve());

  useEffect(() => {
    metadataRef.current = metadata;
  }, [metadata]);

  useEffect(() => {
    let active = true;
    skipNextPersist.current = true;
    hydratedEntryId.current = null;
    sidecarSourceRef.current = null;
    sidecarWritableRef.current = true;
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
        return;
      }

      setSidecarStatus("loading");
      try {
        const sidecar = await readDevelopSidecar(rootPath, entry.relativePath);
        if (!active) {
          return;
        }
        sidecarSourceRef.current = sidecar?.source ?? null;

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
          sidecarWritableRef.current = false;
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

    const develop = createDevelopSettings(settings);
    applyMetadata({ develop });

    const timer = window.setTimeout(() => {
      if (!rootPath || !sidecarWritableRef.current) {
        return;
      }

      setSidecarStatus("saving");
      const write = () =>
        writeDevelopSidecar(
          rootPath,
          entry.relativePath,
          develop,
          metadataRef.current,
          sidecarSourceRef.current,
        );
      const queuedWrite = sidecarWritesRef.current.then(write, write);
      sidecarWritesRef.current = queuedWrite.then(
        () => undefined,
        () => undefined,
      );
      void queuedWrite
        .then((contents) => {
          sidecarSourceRef.current = contents;
          setSidecarStatus("saved");
        })
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
    metadata.rating,
    metadata.colorLabel,
    applyMetadata,
    setSidecarStatus,
  ]);
}
