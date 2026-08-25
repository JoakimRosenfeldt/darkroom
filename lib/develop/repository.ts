import { COLOR_LABELS, type EntryMetadata } from "@/lib/catalog/types";
import type {
  CommittedDevelopCommand,
  DevelopSaveResult,
  DevelopSessionOpenDocument,
  DevelopSessionSnapshot,
  DevelopSessionCore,
} from "@/lib/develop/session";
import { openDevelopSessionDocument } from "@/lib/develop/session";
import {
  readDevelopSidecar,
  digestDevelopSidecarContents,
  writeDevelopSidecar,
  type DevelopSidecar,
} from "@/lib/develop/sidecar";
import {
  createDevelopRevisionId,
  type DevelopHistoryLoadedRevision,
  type DevelopHistoryProjection,
  type DevelopRevisionId,
} from "@/lib/develop/history";
import { parseOperationId } from "@/lib/catalog/ids";
import { getDarkroomAPI, isElectronApp } from "@/lib/fs/platform";
import {
  decodePersistedDevelopDocument,
  MAX_V3_PAYLOAD_BYTES,
} from "@/lib/develop/v3/codec";
import {
  createDefaultV3DevelopDocument,
  type PersistedDevelopDocument,
} from "@/lib/develop/v3/document";
import { MAX_DEVELOP_XMP_PAYLOAD_BYTES } from "@/lib/develop/xmp";
import type { LibraryEntry } from "@/lib/fs/types";

const PERSIST_DEBOUNCE_MS = 500;
const MAX_WRITE_ATTEMPTS_PER_REVISION = 3;
const JOURNAL_VERSION = 1;
const MAX_JOURNAL_BYTES = MAX_V3_PAYLOAD_BYTES + MAX_DEVELOP_XMP_PAYLOAD_BYTES + 256 * 1024;
const JOURNAL_PREFIX = "darkroom:develop-recovery:v1:";

export type DevelopSidecarStatus =
  | "idle"
  | "loading"
  | "saving"
  | "saved"
  | "error";

export type DevelopProjectionState =
  | { readonly kind: "clean"; readonly revisionId: string | null }
  | { readonly kind: "pending"; readonly revisionId: string; readonly reason: string }
  | {
      readonly kind: "divergent";
      readonly headRevisionId: string;
      readonly projectedRevisionId: string | null;
      readonly externalDigest: string | null;
      readonly differences: readonly string[];
    }
  | { readonly kind: "recovery"; readonly message: string }
  | { readonly kind: "unavailable"; readonly reason: string };

export type DevelopProjectionFaultStage =
  | "after-head-commit"
  | "after-xmp-write"
  | "after-projection-record";

export type SidecarMetadataPatch = Partial<
  Pick<EntryMetadata, "rating" | "colorLabel">
>;

export interface DevelopSaveOptions {
  readonly forceRetry?: boolean;
}

export type DevelopRepositoryErrorCode =
  | "journal-invalid"
  | "journal-too-large"
  | "journal-unavailable"
  | "recovery-conflict"
  | "recovery-adapter-unavailable"
  | "retry-exhausted"
  | "retry-required"
  | "sidecar-state-unavailable"
  | "unsupported-process";

export class DevelopRepositoryError extends Error {
  readonly code: DevelopRepositoryErrorCode;

  constructor(code: DevelopRepositoryErrorCode, message: string) {
    super(message);
    this.name = "DevelopRepositoryError";
    this.code = code;
  }
}

export interface DevelopRepositoryAdapters {
  readonly mirrorCatalog: (input: {
    readonly document?: PersistedDevelopDocument;
    readonly sourceUpdatedAt: number;
    readonly metadataPatch: SidecarMetadataPatch;
  }) => Promise<void>;
  readonly hydrateKeywords?: (
    flat: readonly string[],
    hierarchical: readonly string[],
  ) => void;
  readonly setStatus: (
    status: DevelopSidecarStatus,
    error?: string | null,
  ) => void;
  readonly onSessionChanged: (snapshot: DevelopSessionSnapshot) => void;
  readonly setProjectionState?: (state: DevelopProjectionState) => void;
  readonly faultInjector?: (stage: DevelopProjectionFaultStage) => void | Promise<void>;
}

interface PendingWrite {
  readonly snapshot: Extract<DevelopSessionSnapshot, { readonly processKind: "v2" | "v3" }>;
  readonly metadata: Pick<EntryMetadata, "rating" | "colorLabel">;
  readonly ready: Promise<void>;
}

interface FailedWrite {
  readonly documentRevision: number;
  readonly metadataRevision: number;
  readonly attempts: number;
}

interface RecoveryJournal {
  readonly version: typeof JOURNAL_VERSION;
  readonly catalogId: string;
  readonly entryId: string;
  readonly createdAt: number;
  readonly sourceUpdatedAt: number;
  readonly phase: "prepared" | "catalog-written";
  readonly documentDirty: boolean;
  readonly metadataDirty: boolean;
  readonly document: PersistedDevelopDocument;
  readonly metadata: Pick<EntryMetadata, "rating" | "colorLabel">;
  readonly existingContents: string | null;
  readonly expectedLastModified: number | null;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function journalKey(entry: LibraryEntry): string {
  return `${JOURNAL_PREFIX}${encodeURIComponent(entry.catalogId)}:${encodeURIComponent(entry.id)}`;
}

function storage(): Storage {
  if (typeof window === "undefined" || !window.localStorage) {
    throw new DevelopRepositoryError(
      "journal-unavailable",
      "Develop recovery storage is unavailable. Keep this photo open and try saving again.",
    );
  }
  return window.localStorage;
}

function validMetadata(
  value: unknown,
): value is Pick<EntryMetadata, "rating" | "colorLabel"> {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const rating = candidate.rating;
  const colorLabel = candidate.colorLabel;
  return (
    (rating === 0 || rating === 1 || rating === 2 || rating === 3 || rating === 4 || rating === 5) &&
    (colorLabel === null || COLOR_LABELS.some((label) => label === colorLabel))
  );
}

function parseJournal(value: string, entry: LibraryEntry): RecoveryJournal {
  if (new TextEncoder().encode(value).byteLength > MAX_JOURNAL_BYTES) {
    throw new DevelopRepositoryError(
      "journal-too-large",
      "Develop recovery data is larger than the supported limit.",
    );
  }
  let input: unknown;
  try {
    input = JSON.parse(value);
  } catch {
    throw new DevelopRepositoryError(
      "journal-invalid",
      "Develop recovery data is malformed. Remove it before editing this photo.",
    );
  }
  if (typeof input !== "object" || input === null) {
    throw new DevelopRepositoryError("journal-invalid", "Develop recovery data is invalid.");
  }
  const candidate = input as Record<string, unknown>;
  if (
    candidate.version !== JOURNAL_VERSION ||
    candidate.catalogId !== entry.catalogId ||
    candidate.entryId !== entry.id ||
    (candidate.phase !== "prepared" && candidate.phase !== "catalog-written") ||
    typeof candidate.createdAt !== "number" ||
    !Number.isFinite(candidate.createdAt) ||
    typeof candidate.sourceUpdatedAt !== "number" ||
    !Number.isFinite(candidate.sourceUpdatedAt) ||
    typeof candidate.documentDirty !== "boolean" ||
    typeof candidate.metadataDirty !== "boolean" ||
    !validMetadata(candidate.metadata) ||
    (candidate.existingContents !== null && typeof candidate.existingContents !== "string") ||
    (candidate.expectedLastModified !== null &&
      (typeof candidate.expectedLastModified !== "number" ||
        !Number.isFinite(candidate.expectedLastModified)))
  ) {
    throw new DevelopRepositoryError("journal-invalid", "Develop recovery data is invalid.");
  }
  const decoded = decodePersistedDevelopDocument(candidate.document);
  if (decoded.kind !== "editable") {
    throw new DevelopRepositoryError(
      "journal-invalid",
      decoded.kind === "invalid"
        ? decoded.message
        : "Develop recovery cannot rewrite a newer process document.",
    );
  }
  return {
    version: JOURNAL_VERSION,
    catalogId: entry.catalogId,
    entryId: entry.id,
    createdAt: candidate.createdAt,
    sourceUpdatedAt: candidate.sourceUpdatedAt,
    phase: candidate.phase,
    documentDirty: candidate.documentDirty,
    metadataDirty: candidate.metadataDirty,
    document: decoded.document,
    metadata: candidate.metadata,
    existingContents: candidate.existingContents,
    expectedLastModified: candidate.expectedLastModified,
  };
}

function readJournal(entry: LibraryEntry): RecoveryJournal | null {
  let value: string | null;
  try {
    value = storage().getItem(journalKey(entry));
  } catch (error) {
    if (error instanceof DevelopRepositoryError) throw error;
    throw new DevelopRepositoryError(
      "journal-unavailable",
      errorMessage(error, "Develop recovery storage could not be read."),
    );
  }
  return value === null ? null : parseJournal(value, entry);
}

function clearJournal(entry: LibraryEntry): void {
  try {
    storage().removeItem(journalKey(entry));
  } catch (error) {
    if (error instanceof DevelopRepositoryError) throw error;
    throw new DevelopRepositoryError(
      "journal-unavailable",
      errorMessage(error, "Develop recovery data could not be cleared."),
    );
  }
}

export class DevelopRepository {
  readonly #entry: LibraryEntry;
  #adapters: DevelopRepositoryAdapters | null = null;
  #session: DevelopSessionCore | null = null;
  #metadata: EntryMetadata | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #pending: PendingWrite | null = null;
  #queue: Promise<void> = Promise.resolve();
  #hydration: Promise<void> = Promise.resolve();
  #opening: Promise<void> | null = null;
  #sidecarContentsKnown = false;
  #failedWrite: FailedWrite | null = null;
  #head: DevelopHistoryLoadedRevision | null = null;
  #projection: DevelopHistoryProjection | null = null;
  #projectionState: DevelopProjectionState = { kind: "clean", revisionId: null };
  #divergentSidecar: DevelopSidecar | null = null;
  #acceptedExternalDigest: string | null = null;
  #detachCommittedCommands: (() => void) | null = null;
  #lastCommandWrite: Promise<void> = Promise.resolve();
  #configurationRevision = 0;

  constructor(entry: LibraryEntry) {
    this.#entry = entry;
  }

  configure(
    session: DevelopSessionCore,
    metadata: EntryMetadata,
    adapters: DevelopRepositoryAdapters,
  ): () => void {
    if (session.catalogId !== this.#entry.catalogId || session.entryId !== this.#entry.id) {
      throw new DevelopRepositoryError(
        "recovery-adapter-unavailable",
        "Develop session does not belong to this catalog entry.",
      );
    }
    this.#session = session;
    this.#metadata = metadata;
    this.#adapters = adapters;
    session.attachRepository(this);
    this.#detachCommittedCommands?.();
    this.#detachCommittedCommands = session.subscribeCommittedCommands((command) => {
      const documentRevision = session.snapshot().documentRevision;
      this.#lastCommandWrite = this.#enqueueCommittedCommand(command, documentRevision);
    });
    const revision = ++this.#configurationRevision;
    return () => {
      if (this.#configurationRevision !== revision || this.#session !== session) return;
      this.#detachCommittedCommands?.();
      this.#detachCommittedCommands = null;
      this.#session = null;
      this.#adapters = null;
    };
  }

  updateMetadata(metadata: EntryMetadata): void {
    this.#metadata = metadata;
  }

  catalogDocument(metadata: EntryMetadata): DevelopSessionOpenDocument {
    return openDevelopSessionDocument(
      metadata.develop ?? createDefaultV3DevelopDocument(),
    );
  }

  open(metadata: EntryMetadata): Promise<void> {
    this.#metadata = metadata;
    if (this.#opening) return this.#opening;
    this.#adapters?.setStatus("loading");
    const hydrate = async (): Promise<void> => {
      await this.#queue;
      try {
        const adapters = this.#requireAdapters();
        const session = this.#requireSession();
        await this.#recoverJournal();
        if (!isElectronApp()) {
          this.#setProjectionState({ kind: "unavailable", reason: "Persistent Develop history needs the desktop app." });
          this.#adapters?.setStatus("saved");
          return;
        }
        const loaded = await getDarkroomAPI().developHistoryLoad({
          catalogId: this.#entry.catalogId,
          entryId: this.#entry.id,
          revisionId: null,
        });
        if (loaded.kind === "recovery") {
          this.#setProjectionState({ kind: "recovery", message: loaded.corruption.message });
          if (loaded.lastValidRevision) {
            const process = openDevelopSessionDocument(loaded.lastValidRevision.document);
            adapters.onSessionChanged(session.hydrateAuthoritative(process));
          }
          this.#adapters?.setStatus("error", loaded.corruption.message);
          return;
        }
        this.#head = loaded.value;
        adapters.onSessionChanged(session.hydrateAuthoritative(openDevelopSessionDocument(loaded.value.document)));
        const sidecar = await readDevelopSidecar(this.#entry);
        this.#sidecarContentsKnown = true;
        this.#failedWrite = null;
        if (sidecar) adapters.hydrateKeywords?.(sidecar.keywords.flat, sidecar.keywords.hierarchical);
        await this.#reconcileProjection(sidecar);
        this.#adapters?.setStatus("saved");
      } catch (error) {
        this.#adapters?.setStatus(
          "error",
          errorMessage(error, "Could not open Develop settings."),
        );
        throw error;
      }
    };
    const opening = hydrate();
    this.#hydration = opening;
    this.#opening = opening;
    const clearOpening = (): void => {
      if (this.#opening === opening) this.#opening = null;
    };
    void opening.then(clearOpening, clearOpening);
    return opening;
  }

  projectionState(): DevelopProjectionState {
    return structuredClone(this.#projectionState);
  }

  async resolveProjection(choice: "keep-darkroom" | "import-xmp"): Promise<void> {
    const head = this.#head;
    if (!head) throw new DevelopRepositoryError("recovery-adapter-unavailable", "Develop Head is unavailable.");
    if (choice === "keep-darkroom") {
      this.#requireAdapters().onSessionChanged(this.#requireSession().hydrateAuthoritative(openDevelopSessionDocument(head.document)));
      await this.#projectHead(head.revisionId, head.document);
      return;
    }
    const sidecar = this.#divergentSidecar;
    const session = this.#requireSession();
    if (!sidecar) throw new DevelopRepositoryError("recovery-conflict", "The divergent XMP bytes are no longer available.");
    const process = openDevelopSessionDocument(sidecar.document);
    if (process.kind !== "editable" || process.document.version !== 3) {
      throw new DevelopRepositoryError("unsupported-process", "The external XMP document cannot be imported into this editor.");
    }
    this.#requireAdapters().onSessionChanged(session.hydrateAuthoritative(openDevelopSessionDocument(head.document)));
    const externalDigest = await digestDevelopSidecarContents(sidecar.contents);
    if (JSON.stringify(process.document) === JSON.stringify(head.document)) {
      await this.#recordProjection(head.revisionId, externalDigest);
      return;
    }
    this.#acceptedExternalDigest = externalDigest;
    session.dispatch({ kind: "replace-v3-complete-state", document: process.document }, "Import external XMP");
    await this.#lastCommandWrite;
  }

  async preserveBoth(createVirtualCopy: () => Promise<unknown>): Promise<void> {
    const sidecar = this.#divergentSidecar;
    if (!this.#head || !sidecar) {
      throw new DevelopRepositoryError("recovery-conflict", "Both states are not available to preserve.");
    }
    const digest = await digestDevelopSidecarContents(sidecar.contents);
    await createVirtualCopy();
    await this.#importExternalOnly(sidecar, digest);
  }

  commitProcessUpgrade(snapshot: Extract<DevelopSessionSnapshot, { readonly processKind: "v3" }>): Promise<void> {
    const execute = async (): Promise<void> => {
      await this.#hydration;
      const head = this.#head;
      if (!head || !isElectronApp()) throw new DevelopRepositoryError("recovery-adapter-unavailable", "Develop Head is unavailable.");
      if (this.#projectionState.kind === "divergent") {
        throw new DevelopRepositoryError("recovery-conflict", "Resolve the Darkroom and XMP conflict before upgrading this photo.");
      }
      const result = await getDarkroomAPI().developHistoryCommit({
        catalogId: this.#entry.catalogId,
        entryId: this.#entry.id,
        revisionId: createDevelopRevisionId(),
        expectedParentRevisionId: head.revisionId,
        operationId: parseOperationId(crypto.randomUUID()),
        label: "Upgrade to Develop V3",
        document: snapshot.document,
        createdAt: Date.now(),
      });
      const loaded = await getDarkroomAPI().developHistoryLoad({ catalogId: this.#entry.catalogId, entryId: this.#entry.id, revisionId: null });
      if (loaded.kind !== "loaded" || loaded.value.revisionId !== result.revision.revisionId) throw new Error("Upgraded Develop Head could not be verified.");
      this.#head = loaded.value;
      await this.#adapters?.faultInjector?.("after-head-commit");
      if (
        this.#entry.entryKind === "original" &&
        !(await this.#detectConcurrentSidecar(loaded.value))
      ) {
        await this.#projectHead(result.revision.revisionId, snapshot.document);
      }
      const session = this.#requireSession();
      this.#requireAdapters().onSessionChanged(session.markPersisted(snapshot.documentRevision, snapshot.persistedMetadataRevision));
      this.#adapters?.setStatus("saved");
    };
    const write = this.#queue.then(execute, execute);
    this.#queue = write.catch((error: unknown) => {
      this.#setProjectionState({ kind: "recovery", message: errorMessage(error, "Develop upgrade could not be committed.") });
      this.#adapters?.setStatus("error", errorMessage(error, "Develop upgrade could not be committed."));
    });
    return write;
  }

  async #enqueueCommittedCommand(command: CommittedDevelopCommand, documentRevision: number): Promise<void> {
    const execute = async (): Promise<void> => {
      await this.#hydration;
      if (!isElectronApp()) throw new DevelopRepositoryError("recovery-adapter-unavailable", "Persistent Develop history needs the desktop app.");
      const head = this.#head;
      if (!head) throw new DevelopRepositoryError("recovery-adapter-unavailable", "Develop Head is unavailable.");
      if (this.#projectionState.kind === "divergent" && this.#acceptedExternalDigest === null) {
        throw new DevelopRepositoryError("recovery-conflict", "Resolve the Darkroom and XMP conflict before editing.");
      }
      if (JSON.stringify(head.document) !== JSON.stringify(command.before)) {
        throw new DevelopRepositoryError("recovery-conflict", "Develop Head changed before this command could be committed. Reopen the photo.");
      }
      this.#adapters?.setStatus("saving");
      const result = await getDarkroomAPI().developHistoryCommit({
        catalogId: this.#entry.catalogId,
        entryId: this.#entry.id,
        revisionId: createDevelopRevisionId(),
        expectedParentRevisionId: head.revisionId,
        operationId: parseOperationId(command.operationId),
        label: command.label,
        document: command.after,
        createdAt: Date.now(),
      });
      const reloaded = await getDarkroomAPI().developHistoryLoad({ catalogId: this.#entry.catalogId, entryId: this.#entry.id, revisionId: null });
      if (reloaded.kind !== "loaded" || reloaded.value.revisionId !== result.revision.revisionId) {
        throw new DevelopRepositoryError("recovery-conflict", "Committed Develop Head could not be verified.");
      }
      this.#head = reloaded.value;
      await this.#adapters?.faultInjector?.("after-head-commit");
      if (this.#entry.entryKind === "original") {
        const currentSidecar = await readDevelopSidecar(this.#entry);
        const currentDigest = currentSidecar ? await digestDevelopSidecarContents(currentSidecar.contents) : null;
        if (this.#acceptedExternalDigest !== null && currentDigest === this.#acceptedExternalDigest) {
          this.#acceptedExternalDigest = null;
          if (!currentSidecar) throw new Error("Accepted XMP disappeared before projection was recorded.");
          await this.#recordProjection(result.revision.revisionId, currentDigest);
        } else if (await this.#detectConcurrentSidecar(reloaded.value)) {
          this.#acceptedExternalDigest = null;
        } else {
          this.#acceptedExternalDigest = null;
          await this.#projectHead(result.revision.revisionId, command.after);
        }
      }
      const session = this.#requireSession();
      const snapshot = session.snapshot();
      this.#requireAdapters().onSessionChanged(session.markPersisted(documentRevision, snapshot.persistedMetadataRevision));
      this.#failedWrite = null;
      this.#adapters?.setStatus("saved");
    };
    const write = this.#queue.then(execute, execute);
    this.#queue = write.catch((error: unknown) => {
      this.#setProjectionState({ kind: "recovery", message: errorMessage(error, "Develop command could not be committed.") });
      this.#adapters?.setStatus("error", errorMessage(error, "Develop command could not be committed."));
    });
    return write;
  }

  #setProjectionState(state: DevelopProjectionState): void {
    this.#projectionState = state;
    this.#adapters?.setProjectionState?.(structuredClone(state));
  }

  async #recordProjection(revisionId: DevelopRevisionId, contentSha256: string): Promise<void> {
    this.#projection = await getDarkroomAPI().developHistoryRecordProjection({
      catalogId: this.#entry.catalogId,
      entryId: this.#entry.id,
      revisionId,
      contentSha256,
      projectedAt: Date.now(),
    });
    await this.#adapters?.faultInjector?.("after-projection-record");
    this.#divergentSidecar = null;
    this.#setProjectionState({ kind: "clean", revisionId });
  }

  async #projectHead(revisionId: DevelopRevisionId, documentValue: unknown): Promise<void> {
    if (this.#entry.entryKind === "virtual") {
      this.#setProjectionState({ kind: "clean", revisionId });
      return;
    }
    const decoded = decodePersistedDevelopDocument(documentValue);
    if (decoded.kind !== "editable") throw new DevelopRepositoryError("unsupported-process", "This Develop Head cannot be projected to XMP.");
    const metadata = this.#metadata;
    if (!metadata) throw new DevelopRepositoryError("recovery-adapter-unavailable", "Develop metadata is unavailable.");
    const current = await readDevelopSidecar(this.#entry);
    const written = await writeDevelopSidecar(
      this.#entry,
      decoded.document,
      { rating: metadata.rating, colorLabel: metadata.colorLabel },
      current?.contents ?? null,
      current?.lastModified ?? null,
    );
    if (!written) throw new Error("The XMP projection was not written.");
    this.#sidecarContentsKnown = true;
    await this.#adapters?.faultInjector?.("after-xmp-write");
    await this.#recordProjection(revisionId, await digestDevelopSidecarContents(written.contents));
  }

  #differenceSummary(external: DevelopSidecar): readonly string[] {
    const headDocument = this.#head?.document;
    if (!headDocument || typeof headDocument !== "object" || headDocument === null) return ["Develop payload"];
    const externalDocument = external.document;
    if (typeof externalDocument !== "object" || externalDocument === null) return ["Develop payload"];
    const keys = new Set([...Object.keys(headDocument), ...Object.keys(externalDocument)]);
    const changed = [...keys]
      .filter((key) => JSON.stringify(Reflect.get(headDocument, key)) !== JSON.stringify(Reflect.get(externalDocument, key)))
      .filter((key) => key !== "version" && key !== "process" && key !== "schemaRevision")
      .sort();
    return changed.length > 0 ? changed : ["Develop payload"];
  }

  async #detectConcurrentSidecar(head: DevelopHistoryLoadedRevision): Promise<boolean> {
    if (!this.#projection) return false;
    const sidecar = await readDevelopSidecar(this.#entry);
    const digest = sidecar ? await digestDevelopSidecarContents(sidecar.contents) : null;
    if (digest === this.#projection.contentSha256) return false;
    this.#divergentSidecar = sidecar;
    this.#setProjectionState({
      kind: "divergent",
      headRevisionId: head.revisionId,
      projectedRevisionId: this.#projection.revisionId,
      externalDigest: digest,
      differences: sidecar ? this.#differenceSummary(sidecar) : ["XMP file was removed"],
    });
    return true;
  }

  async #importExternalOnly(sidecar: DevelopSidecar, digest: string): Promise<void> {
    const head = this.#head;
    if (!head) throw new Error("Develop Head is unavailable.");
    const process = openDevelopSessionDocument(sidecar.document);
    if (process.kind !== "editable") {
      this.#divergentSidecar = sidecar;
      this.#setProjectionState({
        kind: "divergent",
        headRevisionId: head.revisionId,
        projectedRevisionId: this.#projection?.revisionId ?? null,
        externalDigest: digest,
        differences: this.#differenceSummary(sidecar),
      });
      return;
    }
    const result = await getDarkroomAPI().developHistoryCommit({
      catalogId: this.#entry.catalogId,
      entryId: this.#entry.id,
      revisionId: createDevelopRevisionId(),
      expectedParentRevisionId: head.revisionId,
      operationId: parseOperationId(crypto.randomUUID()),
      label: "Import external XMP",
      document: process.document,
      createdAt: Date.now(),
    });
    const loaded = await getDarkroomAPI().developHistoryLoad({ catalogId: this.#entry.catalogId, entryId: this.#entry.id, revisionId: null });
    if (loaded.kind !== "loaded" || loaded.value.revisionId !== result.revision.revisionId) throw new Error("Imported XMP Head could not be verified.");
    this.#head = loaded.value;
    await this.#adapters?.faultInjector?.("after-head-commit");
    if (this.#adapters && this.#session) {
      this.#adapters.onSessionChanged(this.#session.hydrateAuthoritative(process));
    }
    await this.#recordProjection(result.revision.revisionId, digest);
  }

  async #reconcileProjection(sidecar: DevelopSidecar | null): Promise<void> {
    const head = this.#head;
    if (!head || this.#entry.entryKind === "virtual") {
      this.#setProjectionState({ kind: "clean", revisionId: head?.revisionId ?? null });
      return;
    }
    this.#projection = await getDarkroomAPI().developHistoryProjection({ catalogId: this.#entry.catalogId, entryId: this.#entry.id });
    if (!sidecar) {
      if (this.#projection?.revisionId === head.revisionId) {
        this.#divergentSidecar = null;
        this.#setProjectionState({
          kind: "divergent",
          headRevisionId: head.revisionId,
          projectedRevisionId: this.#projection.revisionId,
          externalDigest: null,
          differences: ["XMP file was removed"],
        });
        return;
      }
      this.#setProjectionState({ kind: "pending", revisionId: head.revisionId, reason: "XMP projection is missing." });
      await this.#projectHead(head.revisionId, head.document);
      return;
    }
    const digest = await digestDevelopSidecarContents(sidecar.contents);
    if (JSON.stringify(sidecar.document) === JSON.stringify(head.document)) {
      await this.#recordProjection(head.revisionId, digest);
      return;
    }
    if (this.#projection && digest === this.#projection.contentSha256 && this.#projection.revisionId !== head.revisionId) {
      this.#setProjectionState({ kind: "pending", revisionId: head.revisionId, reason: "XMP is behind the durable Develop Head." });
      await this.#projectHead(head.revisionId, head.document);
      return;
    }
    if (this.#projection && this.#projection.revisionId === head.revisionId) {
      await this.#importExternalOnly(sidecar, digest);
      return;
    }
    this.#divergentSidecar = sidecar;
    this.#setProjectionState({
      kind: "divergent",
      headRevisionId: head.revisionId,
      projectedRevisionId: this.#projection?.revisionId ?? null,
      externalDigest: digest,
      differences: this.#differenceSummary(sidecar),
    });
  }

  save(
    snapshot: DevelopSessionSnapshot,
    options: DevelopSaveOptions = {},
  ): Promise<DevelopSaveResult> {
    const metadata = this.#metadata;
    if (!metadata) {
      return Promise.reject(
        new DevelopRepositoryError(
          "recovery-adapter-unavailable",
          "Develop persistence is not connected to the active catalog.",
        ),
      );
    }
    if (snapshot.processKind === "read-only-newer") {
      return Promise.reject(
        new DevelopRepositoryError("unsupported-process", snapshot.readOnly.message),
      );
    }
    const failedWrite = this.#failedWrite;
    const retriesFailedRevision =
      failedWrite?.documentRevision === snapshot.documentRevision &&
      failedWrite.metadataRevision === snapshot.metadataRevision;
    if (retriesFailedRevision && !options.forceRetry) {
      return Promise.reject(
        new DevelopRepositoryError(
          "retry-required",
          "The previous save failed. Retry this Develop revision explicitly.",
        ),
      );
    }
    if (
      retriesFailedRevision &&
      failedWrite.attempts >= MAX_WRITE_ATTEMPTS_PER_REVISION
    ) {
      return Promise.reject(
        new DevelopRepositoryError(
          "retry-exhausted",
          "Develop save failed three times. Check catalog and XMP access, then make another edit or reopen the photo.",
        ),
      );
    }
    this.#pending = {
      snapshot: structuredClone(snapshot),
      metadata: {
        rating: metadata.rating,
        colorLabel: metadata.colorLabel,
      },
      ready: this.#hydration,
    };
    if (this.#timer) clearTimeout(this.#timer);
    this.#adapters?.setStatus("saving");
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.flush();
    }, PERSIST_DEBOUNCE_MS);
    return Promise.resolve({
      status: "scheduled",
      documentRevision: snapshot.documentRevision,
      metadataRevision: snapshot.metadataRevision,
    });
  }

  flush(): Promise<void> {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    const pending = this.#pending;
    this.#pending = null;
    if (!pending) return this.#queue;
    const write = () => this.#writeCaptured(pending);
    this.#queue = this.#queue.then(write, write).catch((error: unknown) => {
      const previousFailure = this.#failedWrite;
      const attempts =
        previousFailure?.documentRevision === pending.snapshot.documentRevision &&
        previousFailure.metadataRevision === pending.snapshot.metadataRevision
          ? previousFailure.attempts + 1
          : 1;
      this.#failedWrite = {
        documentRevision: pending.snapshot.documentRevision,
        metadataRevision: pending.snapshot.metadataRevision,
        attempts,
      };
      this.#adapters?.setStatus(
        "error",
        errorMessage(error, "Could not save Develop settings."),
      );
    });
    return this.#queue;
  }

  async #writeCaptured(pending: PendingWrite): Promise<void> {
    await pending.ready;
    const session = this.#requireSession();
    const adapters = this.#requireAdapters();
    const current = session.snapshot();
    if (
      current.documentRevision !== pending.snapshot.documentRevision ||
      current.metadataRevision !== pending.snapshot.metadataRevision
    ) {
      return;
    }
    if (!this.#sidecarContentsKnown) {
      throw new DevelopRepositoryError(
        "sidecar-state-unavailable",
        "XMP state is unknown. Reopen the photo before saving again.",
      );
    }
    const metadataDirty =
      pending.snapshot.metadataRevision !== pending.snapshot.persistedMetadataRevision;
    if (!metadataDirty) return;
    if (
      this.#head &&
      this.#entry.entryKind === "original" &&
      await this.#detectConcurrentSidecar(this.#head)
    ) {
      return;
    }
    const sourceUpdatedAt = Date.now();
    await adapters.mirrorCatalog({
      sourceUpdatedAt,
      metadataPatch: pending.metadata,
    });
    if (this.#head && this.#entry.entryKind === "original") {
      await this.#projectHead(this.#head.revisionId, this.#head.document);
    }
    this.#failedWrite = null;
    adapters.onSessionChanged(
      session.markPersisted(
        session.snapshot().persistedDocumentRevision,
        pending.snapshot.metadataRevision,
      ),
    );
    adapters.setStatus("saved");
  }

  async #recoverJournal(): Promise<void> {
    const journal = readJournal(this.#entry);
    if (!journal) return;
    const adapters = this.#adapters;
    if (!adapters) {
      throw new DevelopRepositoryError(
        "recovery-adapter-unavailable",
        "Develop recovery needs the original catalog. Reopen it before editing or exporting.",
      );
    }
    if (journal.metadataDirty) {
      await adapters.mirrorCatalog({
        sourceUpdatedAt: journal.sourceUpdatedAt,
        metadataPatch: journal.metadata,
      });
    }
    clearJournal(this.#entry);
  }

  async resolveDocument(metadata: EntryMetadata): Promise<DevelopSessionOpenDocument> {
    await this.flush();
    if (!isElectronApp()) return this.catalogDocument(metadata);
    const loaded = await getDarkroomAPI().developHistoryLoad({
      catalogId: this.#entry.catalogId,
      entryId: this.#entry.id,
      revisionId: null,
    });
    if (loaded.kind === "loaded") return openDevelopSessionDocument(loaded.value.document);
    if (loaded.lastValidRevision) return openDevelopSessionDocument(loaded.lastValidRevision.document);
    throw new DevelopRepositoryError("recovery-conflict", loaded.corruption.message);
  }

  #requireAdapters(): DevelopRepositoryAdapters {
    if (!this.#adapters) {
      throw new DevelopRepositoryError(
        "recovery-adapter-unavailable",
        "Develop persistence is not connected to the active catalog.",
      );
    }
    return this.#adapters;
  }

  #requireSession(): DevelopSessionCore {
    if (!this.#session) {
      throw new DevelopRepositoryError(
        "recovery-adapter-unavailable",
        "Develop persistence is not connected to an editing session.",
      );
    }
    return this.#session;
  }
}

const repositories = new Map<string, DevelopRepository>();

export function getDevelopRepository(entry: LibraryEntry): DevelopRepository {
  const key = JSON.stringify([entry.catalogId, entry.id, entry.assetRevision]);
  const existing = repositories.get(key);
  if (existing) return existing;
  const repository = new DevelopRepository(entry);
  repositories.set(key, repository);
  return repository;
}

export async function resolveDevelopDocumentFromRepository(
  entry: LibraryEntry,
  metadata: EntryMetadata,
): Promise<DevelopSessionOpenDocument> {
  return getDevelopRepository(entry).resolveDocument(metadata);
}
