"use client";

import { useEffect, useRef } from "react";
import type { EntryMetadata } from "@/lib/catalog/types";
import type { DevelopDocument } from "@/lib/develop/types";
import type { LibraryEntry } from "@/lib/fs/types";
import { resolveDevelopDocument } from "@/lib/export/settings";
import { readDevelopSidecar, writeDevelopSidecar } from "@/lib/develop/sidecar";
import { useDevelopStore } from "@/stores/develop-store";

const PERSIST_DEBOUNCE_MS = 500;
type SidecarMetadataPatch = Partial<Pick<EntryMetadata, "rating" | "colorLabel">>;

interface UseDevelopSettingsSyncOptions {
  entry: LibraryEntry;
  rootPath: string | null;
  metadata: EntryMetadata;
  mirrorDocument: (
    document: DevelopDocument,
    sourceUpdatedAt?: number,
    metadataPatch?: SidecarMetadataPatch,
  ) => void;
  hydrateMetadata: (patch: SidecarMetadataPatch, sourceUpdatedAt: number) => void;
}

interface PendingWrite {
  entryId: string;
  rootPath: string | null;
  relativePath: string;
  documentRevision: number;
  metadataRevision: number;
  document: DevelopDocument;
  metadata: Pick<EntryMetadata, "rating" | "colorLabel">;
  mirrorDocument: (
    document: DevelopDocument,
    sourceUpdatedAt?: number,
    metadataPatch?: SidecarMetadataPatch,
  ) => void;
  ready: Promise<void>;
}

interface EntryPersistence {
  timer: ReturnType<typeof setTimeout> | null;
  pending: PendingWrite | null;
  queue: Promise<void>;
  sidecarContents: string | null;
  sidecarContentsKnown: boolean;
  failedWrite: Pick<PendingWrite, "documentRevision" | "metadataRevision"> | null;
  hydration: Promise<void>;
}

const persistenceByEntry = new Map<string, EntryPersistence>();

function persistenceFor(entryId: string): EntryPersistence {
  const current = persistenceByEntry.get(entryId);
  if (current) return current;
  const created: EntryPersistence = {
    timer: null,
    pending: null,
    queue: Promise.resolve(),
    sidecarContents: null,
    sidecarContentsKnown: false,
    failedWrite: null,
    hydration: Promise.resolve(),
  };
  persistenceByEntry.set(entryId, created);
  return created;
}

function setStatusForEntry(
  entryId: string,
  status: "saving" | "saved" | "error",
  error?: string,
): void {
  if (useDevelopStore.getState().activeEntryId === entryId) {
    useDevelopStore.getState().setSidecarStatus(status, error ?? null);
  }
}

async function writeCaptured(captured: PendingWrite): Promise<void> {
  await captured.ready;
  const persistence = persistenceFor(captured.entryId);
  const current = useDevelopStore.getState().sessions[captured.entryId];
  if (
    !current ||
    current.documentRevision !== captured.documentRevision ||
    current.metadataRevision !== captured.metadataRevision
  ) return;
  if (current.documentRevision !== current.persistedDocumentRevision) {
    captured.mirrorDocument(captured.document);
  }
  if (captured.rootPath) {
    if (!persistence.sidecarContentsKnown) return;
    persistence.sidecarContents = await writeDevelopSidecar(
      captured.rootPath,
      captured.relativePath,
      captured.document,
      captured.metadata,
      persistence.sidecarContents,
    );
  }
  persistence.failedWrite = null;
  useDevelopStore.getState().markPersisted(
    captured.entryId,
    captured.documentRevision,
    captured.metadataRevision,
  );
  setStatusForEntry(captured.entryId, "saved");
}

function flushEntry(entryId: string): Promise<void> {
  const persistence = persistenceByEntry.get(entryId);
  if (!persistence) return Promise.resolve();
  if (persistence.timer) {
    clearTimeout(persistence.timer);
    persistence.timer = null;
  }
  const captured = persistence.pending;
  persistence.pending = null;
  if (!captured) return persistence.queue;
  const write = () => writeCaptured(captured);
  persistence.queue = persistence.queue.then(write, write).catch((error: unknown) => {
    persistence.failedWrite = {
      documentRevision: captured.documentRevision,
      metadataRevision: captured.metadataRevision,
    };
    setStatusForEntry(
      entryId,
      "error",
      error instanceof Error ? error.message : "Could not write XMP sidecar.",
    );
  });
  return persistence.queue;
}

function scheduleWrite(captured: PendingWrite): void {
  const persistence = persistenceFor(captured.entryId);
  persistence.pending = captured;
  if (persistence.timer) clearTimeout(persistence.timer);
  persistence.timer = setTimeout(() => {
    persistence.timer = null;
    void flushEntry(captured.entryId);
  }, PERSIST_DEBOUNCE_MS);
}

export function useDevelopSettingsSync({
  entry,
  rootPath,
  metadata,
  mirrorDocument,
  hydrateMetadata,
}: UseDevelopSettingsSyncOptions): void {
  const session = useDevelopStore((state) => state.sessions[entry.id]);
  const documentRevision = session?.documentRevision;
  const persistedDocumentRevision = session?.persistedDocumentRevision;
  const metadataRevision = session?.metadataRevision;
  const persistedMetadataRevision = session?.persistedMetadataRevision;
  const document = session?.document;
  const sidecarStatus = session?.ui.sidecarStatus;
  const activateEntry = useDevelopStore((state) => state.activateEntry);
  const hydrateEntry = useDevelopStore((state) => state.hydrateEntry);
  const markMetadataHydrated = useDevelopStore((state) => state.markMetadataHydrated);
  const setSidecarStatus = useDevelopStore((state) => state.setSidecarStatus);
  const metadataRef = useRef(metadata);

  useEffect(() => {
    metadataRef.current = metadata;
  }, [metadata]);

  useEffect(() => {
    let active = true;
    const catalogDocument = resolveDevelopDocument(null, metadataRef.current);
    activateEntry(entry.id, catalogDocument);
    setSidecarStatus("loading");
    const persistence = persistenceFor(entry.id);

    async function hydrate(): Promise<void> {
      await persistence.queue;
      try {
        const sidecar = rootPath
          ? await readDevelopSidecar(rootPath, entry.relativePath)
          : null;
        if (!active) return;
        persistence.sidecarContents = sidecar?.contents ?? null;
        persistence.sidecarContentsKnown = true;
        persistence.failedWrite = null;
        if (sidecar) {
          const metadataSnapshot = metadataRef.current;
          const documentIsNewer = sidecar.lastModified > metadataSnapshot.developUpdatedAt;
          const metadataIsNewer = sidecar.lastModified > metadataSnapshot.updatedAt;
          const metadataPatch: SidecarMetadataPatch = metadataIsNewer
            ? {
                ...(sidecar.rating === undefined ? {} : { rating: sidecar.rating }),
                ...(sidecar.colorLabel === undefined ? {} : { colorLabel: sidecar.colorLabel }),
              }
            : {};
          const hasMetadataPatch = Object.keys(metadataPatch).length > 0;
          const current = useDevelopStore.getState().sessions[entry.id];
          const canHydrateDocument = documentIsNewer && current &&
            current.documentRevision === current.persistedDocumentRevision;
          if (canHydrateDocument) {
            hydrateEntry(entry.id, sidecar.document);
            mirrorDocument(
              sidecar.document,
              sidecar.lastModified,
              metadataPatch,
            );
          } else if (hasMetadataPatch) {
            hydrateMetadata(metadataPatch, sidecar.lastModified);
          }
          if (hasMetadataPatch) markMetadataHydrated(entry.id);
        }
        setSidecarStatus("saved");
      } catch (error) {
        if (!active) return;
        persistence.sidecarContentsKnown = false;
        setSidecarStatus(
          "error",
          error instanceof Error ? error.message : "Could not read XMP sidecar.",
        );
      }
    }

    persistence.hydration = hydrate();
    return () => {
      active = false;
      void flushEntry(entry.id);
    };
  }, [
    activateEntry,
    entry.id,
    entry.relativePath,
    hydrateEntry,
    hydrateMetadata,
    markMetadataHydrated,
    mirrorDocument,
    rootPath,
    setSidecarStatus,
  ]);

  useEffect(() => {
    const persistence = persistenceFor(entry.id);
    const failedWrite = persistence.failedWrite;
    if (
      !document ||
      documentRevision === undefined ||
      metadataRevision === undefined ||
      (sidecarStatus !== "saved" && sidecarStatus !== "error") ||
      (
        documentRevision === persistedDocumentRevision &&
        metadataRevision === persistedMetadataRevision
      )
    ) return;
    if (rootPath !== null && !persistence.sidecarContentsKnown) {
      if (documentRevision !== persistedDocumentRevision) {
        mirrorDocument(structuredClone(document));
      }
      return;
    }
    if (
      failedWrite?.documentRevision === documentRevision &&
      failedWrite.metadataRevision === metadataRevision
    ) return;
    setStatusForEntry(entry.id, "saving");
    scheduleWrite({
      entryId: entry.id,
      rootPath,
      relativePath: entry.relativePath,
      documentRevision,
      metadataRevision,
      document: structuredClone(document),
      metadata: { rating: metadata.rating, colorLabel: metadata.colorLabel },
      mirrorDocument,
      ready: persistence.hydration,
    });
  }, [
    entry.id,
    entry.relativePath,
    metadata.colorLabel,
    metadata.rating,
    mirrorDocument,
    rootPath,
    document,
    documentRevision,
    metadataRevision,
    persistedDocumentRevision,
    persistedMetadataRevision,
    sidecarStatus,
  ]);
}
