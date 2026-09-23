"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { EntryMetadata } from "@/lib/catalog/types";
import {
  DevelopRepositoryError,
  getDevelopRepository,
  type SidecarMetadataPatch,
} from "@/lib/develop/repository";
import { DevelopSessionCommandError, getDevelopSession } from "@/lib/develop/session";
import { sourceSignatureForEntry } from "@/lib/develop/source-transform";
import type { PersistedDevelopDocument } from "@/lib/develop/v3/document";
import { createV3UpgradeAssetCopyAdapter } from "@/lib/develop/v3/upgrade-asset-copy";
import type { LibraryEntry } from "@/lib/fs/types";
import { useDevelopStore } from "@/stores/develop-store";
import { useLibraryStore } from "@/stores/library-store";
import type { DevelopDefaultFacts } from "@/lib/develop/defaults/matcher";
import { parseOperationId } from "@/lib/catalog/ids";
import type { InstalledDevelopDefault } from "@/lib/develop/defaults/installed";

export type DevelopDefaultsResolution =
  | { readonly kind: "pending" }
  | { readonly kind: "installed"; readonly installed: InstalledDevelopDefault }
  | { readonly kind: "no-match" }
  | { readonly kind: "existing"; readonly installed: InstalledDevelopDefault | null }
  | { readonly kind: "failed"; readonly message: string };

interface DefaultsResolutionState {
  readonly key: string;
  readonly value: DevelopDefaultsResolution;
}

interface RepositoryHydrationState {
  readonly entry: LibraryEntry;
  readonly repository: ReturnType<typeof getDevelopRepository>;
  readonly session: NonNullable<ReturnType<typeof getDevelopSession>>;
  readonly attempt: object;
}

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
    metadataPatch?: SidecarMetadataPatch,
    sourceUpdatedAt?: number,
  ) => Promise<void>;
  defaultFacts?: DevelopDefaultFacts | null;
}

export function useDevelopSettingsSync({
  entry,
  metadata,
  persistCatalog,
  hydrateKeywords,
  defaultFacts,
}: UseDevelopSettingsSyncOptions): DevelopDefaultsResolution {
  const [defaultsResolution, setDefaultsResolution] = useState<DefaultsResolutionState | null>(null);
  const [repositoryHydration, setRepositoryHydration] = useState<RepositoryHydrationState | null>(null);
  const defaultsIdentityKey = JSON.stringify([
    entry.catalogId,
    entry.sessionId,
    entry.id,
    entry.sourceId,
    entry.assetId,
    entry.assetRevision,
  ]);
  const defaultsKey = defaultFacts
    ? JSON.stringify([defaultsIdentityKey, defaultFacts])
    : null;
  const readDefaultRequest = useEffectEvent(() => ({
    facts: defaultFacts,
    repository: getDevelopRepository(entry),
  }));
  const { documentRevision, persistedDocumentRevision, metadataRevision, persistedMetadataRevision, sidecarStatus } = useDevelopStore(useShallow((state) => {
    const session = state.sessions[entry.id];
    return {
      documentRevision: session?.documentRevision,
      persistedDocumentRevision: session?.persistedDocumentRevision,
      metadataRevision: session?.metadataRevision,
      persistedMetadataRevision: session?.persistedMetadataRevision,
      sidecarStatus: session?.ui.sidecarStatus,
    };
  }));
  const activateEntry = useDevelopStore((state) => state.activateEntry);
  const beginDefaultResolution = useDevelopStore((state) => state.beginDefaultResolution);
  const finishDefaultResolution = useDevelopStore((state) => state.finishDefaultResolution);
  const synchronizeSession = useDevelopStore((state) => state.synchronizeSession);
  const setSidecarStatus = useDevelopStore((state) => state.setSidecarStatus);
  const setProjectionState = useDevelopStore((state) => state.setProjectionState);
  const metadataRef = useRef(metadata);
  const repositoryOpenAttemptRef = useRef<object | null>(null);
  const upgradeAttemptRef = useRef<object | null>(null);
  const scheduledRevisionRef = useRef<{
    readonly catalogId: string;
    readonly entryId: string;
    readonly document: number;
    readonly metadata: number;
  } | null>(null);
  const exhaustedRevisionRef = useRef<{
    readonly catalogId: string;
    readonly entryId: string;
    readonly document: number;
    readonly metadata: number;
  } | null>(null);
  const repository = getDevelopRepository(entry);
  const pendingDefaultOperation = useDevelopStore((state) =>
    state.pendingDefaultOperations[JSON.stringify([entry.catalogId, entry.id])],
  );
  const activeProcessKind = useDevelopStore((state) =>
    state.activeCatalogId === entry.catalogId && state.activeEntryId === entry.id
      ? state.sessions[entry.id]?.processKind
      : undefined,
  );

  useEffect(() => {
    metadataRef.current = metadata;
    getDevelopRepository(entry).updateMetadata(metadata);
  }, [entry, metadata]);

  useEffect(() => {
    let active = true;
    const catalogDocument = repository.catalogDocument(metadataRef.current);
    activateEntry(entry.catalogId, entry.id, catalogDocument);
    const session = getDevelopSession(entry.catalogId, entry.id);
    if (!session) return;
    const attempt = {};
    repositoryOpenAttemptRef.current = attempt;
    const detachSourceSignatureProvider = session.attachSourceSignatureProvider(() => {
      const currentEntry = useLibraryStore.getState().entries.find(
        (candidate) =>
          candidate.catalogId === entry.catalogId && candidate.id === entry.id,
      );
      return currentEntry?.health === "present"
        ? sourceSignatureForEntry(currentEntry)
        : null;
    });
    session.attachUpgradeAssetCopy(createV3UpgradeAssetCopyAdapter({
      entry,
      currentDocument: () => {
        const snapshot = session.snapshot();
        return snapshot.processKind === "v2" ? snapshot.document : null;
      },
    }));
    const disconnectRepository = repository.configure(session, metadataRef.current, {
      mirrorCatalog: persistCatalog,
      applyExternalMetadata: async (sidecar) => {
        const patch: SidecarMetadataPatch = {
          rating: sidecar.rating ?? 0,
          colorLabel: sidecar.colorLabel ?? null,
        };
        await hydrateKeywords?.(
          sidecar.keywords.flat,
          sidecar.keywords.hierarchical,
          patch,
          sidecar.lastModified,
        );
      },
      projectCatalogKeywords: () => useLibraryStore.getState().persistEntryKeywords(entry.id),
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
      setProjectionState: (projection) => {
        const state = useDevelopStore.getState();
        if (state.activeCatalogId === entry.catalogId && state.activeEntryId === entry.id) {
          setProjectionState(projection);
        }
      },
    });
    void repository.open(metadataRef.current).then(() => {
      if (active && repositoryOpenAttemptRef.current === attempt) {
        setRepositoryHydration({ entry, repository, session, attempt });
      }
    }).catch(() => undefined);
    return () => {
      active = false;
      if (repositoryOpenAttemptRef.current === attempt) {
        repositoryOpenAttemptRef.current = null;
      }
      detachSourceSignatureProvider();
      void repository.flush().finally(disconnectRepository);
    };
  }, [
    activateEntry,
    entry,
    entry.id,
    hydrateKeywords,
    persistCatalog,
    repository,
    setSidecarStatus,
    setProjectionState,
    synchronizeSession,
  ]);

  useEffect(() => {
    const hydration = repositoryHydration;
    if (
      !hydration ||
      hydration.entry !== entry ||
      hydration.repository !== repository ||
      hydration.attempt !== repositoryOpenAttemptRef.current ||
      activeProcessKind !== "v2" ||
      pendingDefaultOperation !== undefined
    ) {
      return;
    }
    const { catalogId, id } = entry;
    const { attempt, session } = hydration;
    const current = () => {
      const state = useDevelopStore.getState();
      return repositoryOpenAttemptRef.current === attempt &&
        getDevelopSession(catalogId, id) === session &&
        state.activeCatalogId === catalogId &&
        state.activeEntryId === id;
    };
    if (!current() || upgradeAttemptRef.current === attempt) return;
    upgradeAttemptRef.current = attempt;
    void (async () => {
      try {
        const snapshot = await session.upgradeToCurrentProcess();
        if (!current()) {
          if (upgradeAttemptRef.current === attempt) upgradeAttemptRef.current = null;
          return;
        }
        if (snapshot.processKind !== "v3") return;
        synchronizeSession(id, snapshot);
        await repository.commitProcessUpgrade(snapshot);
      } catch (error) {
        if (!current()) {
          if (upgradeAttemptRef.current === attempt) upgradeAttemptRef.current = null;
          return;
        }
        const pending = useDevelopStore.getState().pendingDefaultOperations[
          JSON.stringify([catalogId, id])
        ];
        if (error instanceof DevelopSessionCommandError && error.code === "edit-blocked" && pending) {
          if (upgradeAttemptRef.current === attempt) upgradeAttemptRef.current = null;
          return;
        }
        setSidecarStatus(
          "error",
          error instanceof Error ? error.message : "Could not prepare the editor.",
        );
      }
    })();
  }, [
    activeProcessKind,
    entry,
    pendingDefaultOperation,
    repository,
    repositoryHydration,
    setSidecarStatus,
    synchronizeSession,
  ]);

  useEffect(() => {
    if (defaultFacts !== undefined) return;
    const operationId = crypto.randomUUID();
    beginDefaultResolution(entry.catalogId, entry.id, operationId);
    return () => finishDefaultResolution(entry.catalogId, entry.id, operationId);
  }, [beginDefaultResolution, defaultFacts, entry.catalogId, entry.id, finishDefaultResolution]);

  useEffect(() => {
    if (!defaultsKey) return;
    const request = readDefaultRequest();
    if (!request.facts) return;
    let active = true;
    let settled = false;
    const repository = request.repository;
    const requestId = parseOperationId(crypto.randomUUID());
    beginDefaultResolution(entry.catalogId, entry.id, requestId);
    const operation = repository.installDefault(request.facts, requestId).then((result) => {
      if (!active) return;
      if (result.kind === "installed" || result.kind === "already-installed") {
        setDefaultsResolution({ key: defaultsKey, value: { kind: "installed", installed: result.installed } });
      } else if (result.kind === "no-match") {
        setDefaultsResolution({ key: defaultsKey, value: { kind: "no-match" } });
      } else {
        setDefaultsResolution({ key: defaultsKey, value: { kind: "existing", installed: repository.installedDefault() } });
      }
    }).catch((error: unknown) => {
      if (!active) return;
      const message = error instanceof Error ? error.message : "Could not apply the Develop default.";
      setDefaultsResolution({ key: defaultsKey, value: { kind: "failed", message } });
      const state = useDevelopStore.getState();
      if (state.activeCatalogId === entry.catalogId && state.activeEntryId === entry.id) {
        setSidecarStatus("error", message);
      }
    });
    void operation.finally(() => {
      settled = true;
      finishDefaultResolution(entry.catalogId, entry.id, requestId);
    });
    return () => {
      active = false;
      if (!settled) void repository.cancelDefault(requestId);
    };
  }, [beginDefaultResolution, defaultsKey, entry.catalogId, entry.id, finishDefaultResolution, setSidecarStatus]);

  useEffect(() => {
    const alreadyScheduled =
      scheduledRevisionRef.current?.catalogId === entry.catalogId &&
      scheduledRevisionRef.current.entryId === entry.id &&
      scheduledRevisionRef.current.document === documentRevision &&
      scheduledRevisionRef.current.metadata === metadataRevision;
    const retryExhausted =
      exhaustedRevisionRef.current?.catalogId === entry.catalogId &&
      exhaustedRevisionRef.current.entryId === entry.id &&
      exhaustedRevisionRef.current.document === documentRevision &&
      exhaustedRevisionRef.current.metadata === metadataRevision;
    if (
      documentRevision === undefined ||
      metadataRevision === undefined ||
      sidecarStatus === "idle" ||
      sidecarStatus === "loading" ||
      retryExhausted ||
      (sidecarStatus === "saving" && alreadyScheduled) ||
      (
        documentRevision === persistedDocumentRevision &&
        metadataRevision === persistedMetadataRevision
      )
    ) {
      return;
    }
    const session = getDevelopSession(entry.catalogId, entry.id);
    if (!session) return;
    scheduledRevisionRef.current = {
      catalogId: entry.catalogId,
      entryId: entry.id,
      document: documentRevision,
      metadata: metadataRevision,
    };
    const repository = getDevelopRepository(entry);
    void repository.save(
      session.snapshot(),
      { forceRetry: sidecarStatus === "error" },
    ).catch((error: unknown) => {
      if (
        error instanceof DevelopRepositoryError &&
        error.code === "retry-exhausted"
      ) {
        exhaustedRevisionRef.current = {
          catalogId: entry.catalogId,
          entryId: entry.id,
          document: documentRevision,
          metadata: metadataRevision,
        };
      }
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
    entry,
    metadataRevision,
    persistedDocumentRevision,
    persistedMetadataRevision,
    setSidecarStatus,
    sidecarStatus,
  ]);

  if (defaultFacts === undefined) return { kind: "pending" };
  if (defaultFacts === null) return { kind: "no-match" };
  return defaultsResolution?.key === defaultsKey ? defaultsResolution.value : { kind: "pending" };
}
