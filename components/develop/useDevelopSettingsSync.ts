"use client";

import { useEffect, useRef } from "react";
import type { EntryMetadata } from "@/lib/catalog/types";
import {
  getDevelopRepository,
  type SidecarMetadataPatch,
} from "@/lib/develop/repository";
import { getDevelopSession } from "@/lib/develop/session";
import type { PersistedDevelopDocument } from "@/lib/develop/v3/document";
import type { LibraryEntry } from "@/lib/fs/types";
import { useDevelopStore } from "@/stores/develop-store";

interface UseDevelopSettingsSyncOptions {
  entry: LibraryEntry;
  metadata: EntryMetadata;
  persistCatalog: (input: {
    readonly document?: PersistedDevelopDocument;
    readonly sourceUpdatedAt: number;
    readonly metadataPatch: SidecarMetadataPatch;
  }) => Promise<void>;
  hydrateKeywords?: (
    flat: readonly string[],
    hierarchical: readonly string[],
  ) => void;
}

export function useDevelopSettingsSync({
  entry,
  metadata,
  persistCatalog,
  hydrateKeywords,
}: UseDevelopSettingsSyncOptions): void {
  const sessionState = useDevelopStore((state) => state.sessions[entry.id]);
  const documentRevision = sessionState?.documentRevision;
  const persistedDocumentRevision = sessionState?.persistedDocumentRevision;
  const metadataRevision = sessionState?.metadataRevision;
  const persistedMetadataRevision = sessionState?.persistedMetadataRevision;
  const sidecarStatus = sessionState?.ui.sidecarStatus;
  const activateEntry = useDevelopStore((state) => state.activateEntry);
  const synchronizeSession = useDevelopStore((state) => state.synchronizeSession);
  const setSidecarStatus = useDevelopStore((state) => state.setSidecarStatus);
  const metadataRef = useRef(metadata);

  useEffect(() => {
    metadataRef.current = metadata;
    getDevelopRepository(entry).updateMetadata(metadata);
  }, [entry, metadata]);

  useEffect(() => {
    const repository = getDevelopRepository(entry);
    const catalogDocument = repository.catalogDocument(metadataRef.current);
    activateEntry(entry.catalogId, entry.id, catalogDocument);
    const session = getDevelopSession(entry.catalogId, entry.id);
    if (!session) return;
    repository.configure(session, metadataRef.current, {
      mirrorCatalog: persistCatalog,
      hydrateKeywords,
      setStatus: (status, error = null) => {
        const state = useDevelopStore.getState();
        if (
          state.activeCatalogId === entry.catalogId &&
          state.activeEntryId === entry.id
        ) {
          setSidecarStatus(status, error);
        }
      },
      onSessionChanged: (snapshot) => {
        synchronizeSession(entry.id, snapshot);
      },
    });
    void repository.open(metadataRef.current).catch(() => undefined);
    return () => {
      void repository.flush();
    };
  }, [
    activateEntry,
    entry,
    entry.id,
    hydrateKeywords,
    persistCatalog,
    setSidecarStatus,
    synchronizeSession,
  ]);

  useEffect(() => {
    if (
      documentRevision === undefined ||
      metadataRevision === undefined ||
      sidecarStatus === "idle" ||
      sidecarStatus === "loading" ||
      (
        documentRevision === persistedDocumentRevision &&
        metadataRevision === persistedMetadataRevision
      )
    ) {
      return;
    }
    const session = getDevelopSession(entry.catalogId, entry.id);
    if (!session) return;
    void session.save().catch((error: unknown) => {
      const state = useDevelopStore.getState();
      if (
        state.activeCatalogId === entry.catalogId &&
        state.activeEntryId === entry.id
      ) {
        setSidecarStatus(
          "error",
          error instanceof Error ? error.message : "Could not save Develop settings.",
        );
      }
    });
  }, [
    documentRevision,
    entry.catalogId,
    entry.id,
    metadataRevision,
    persistedDocumentRevision,
    persistedMetadataRevision,
    setSidecarStatus,
    sidecarStatus,
  ]);
}
