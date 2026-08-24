import { COLOR_LABELS, type EntryMetadata } from "@/lib/catalog/types";
import type {
  DevelopSaveResult,
  DevelopSessionOpenDocument,
  DevelopSessionSnapshot,
  DevelopSessionCore,
} from "@/lib/develop/session";
import { openDevelopSessionDocument } from "@/lib/develop/session";
import {
  readDevelopSidecar,
  writeDevelopSidecar,
  type DevelopSidecar,
} from "@/lib/develop/sidecar";
import {
  decodePersistedDevelopDocument,
  MAX_V3_PAYLOAD_BYTES,
} from "@/lib/develop/v3/codec";
import {
  createDefaultV3DevelopDocument,
  type PersistedDevelopDocument,
} from "@/lib/develop/v3/document";
import {
  MAX_DEVELOP_XMP_PAYLOAD_BYTES,
  serializeDevelopXmp,
} from "@/lib/develop/xmp";
import type { LibraryEntry } from "@/lib/fs/types";
import { resolveStoredDevelopDocument } from "@/lib/export/settings";

const PERSIST_DEBOUNCE_MS = 500;
const MAX_WRITE_ATTEMPTS_PER_REVISION = 3;
const JOURNAL_VERSION = 1;
const MAX_JOURNAL_BYTES = MAX_V3_PAYLOAD_BYTES + MAX_DEVELOP_XMP_PAYLOAD_BYTES + 256 * 1024;
const MAX_JOURNAL_ENTRIES = 32;
const MAX_TOTAL_JOURNAL_BYTES = MAX_JOURNAL_BYTES * 2;
const JOURNAL_PREFIX = "darkroom:develop-recovery:v1:";

export type DevelopSidecarStatus =
  | "idle"
  | "loading"
  | "saving"
  | "saved"
  | "error";

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

function writeJournal(entry: LibraryEntry, journal: RecoveryJournal): void {
  const value = JSON.stringify(journal);
  const encoder = new TextEncoder();
  const valueBytes = encoder.encode(value).byteLength;
  if (valueBytes > MAX_JOURNAL_BYTES) {
    throw new DevelopRepositoryError(
      "journal-too-large",
      "Develop recovery data is larger than the supported limit.",
    );
  }
  try {
    const localStorage = storage();
    const targetKey = journalKey(entry);
    let entryCount = 0;
    let totalBytes = valueBytes;
    let targetExists = false;
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(JOURNAL_PREFIX)) continue;
      entryCount += 1;
      if (key === targetKey) {
        targetExists = true;
        continue;
      }
      const existing = localStorage.getItem(key);
      if (existing !== null) totalBytes += encoder.encode(existing).byteLength;
    }
    if ((!targetExists && entryCount >= MAX_JOURNAL_ENTRIES) || totalBytes > MAX_TOTAL_JOURNAL_BYTES) {
      throw new DevelopRepositoryError(
        "journal-too-large",
        "Develop recovery storage is full. Reopen photos with pending recovery before saving more edits.",
      );
    }
    localStorage.setItem(targetKey, value);
  } catch (error) {
    if (error instanceof DevelopRepositoryError) throw error;
    throw new DevelopRepositoryError(
      "journal-unavailable",
      errorMessage(error, "Develop recovery data could not be saved."),
    );
  }
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

function sameSidecarContents(
  sidecar: DevelopSidecar | null,
  expected: string | null,
): boolean {
  return expected === null ? sidecar === null : sidecar?.contents === expected;
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
  #sidecarContents: string | null = null;
  #sidecarLastModified: number | null = null;
  #sidecarContentsKnown = false;
  #failedWrite: FailedWrite | null = null;

  constructor(entry: LibraryEntry) {
    this.#entry = entry;
  }

  configure(
    session: DevelopSessionCore,
    metadata: EntryMetadata,
    adapters: DevelopRepositoryAdapters,
  ): void {
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
        await this.#recoverJournal();
        const sidecar = await readDevelopSidecar(this.#entry);
        this.#sidecarContents = sidecar?.contents ?? null;
        this.#sidecarLastModified = sidecar?.lastModified ?? null;
        this.#sidecarContentsKnown = true;
        this.#failedWrite = null;
        await this.#reconcile(sidecar, this.#metadata ?? metadata);
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

  async #reconcile(
    sidecar: DevelopSidecar | null,
    metadata: EntryMetadata,
  ): Promise<void> {
    const adapters = this.#requireAdapters();
    const session = this.#requireSession();
    if (sidecar) {
      adapters.hydrateKeywords?.(
        sidecar.keywords.flat,
        sidecar.keywords.hierarchical,
      );
    }
    const sidecarLastModified = sidecar?.lastModified ?? 0;
    const sidecarDocumentIsNewer = sidecar !== null &&
      sidecarLastModified > metadata.developUpdatedAt;
    const sidecarMetadataIsNewer = sidecar !== null &&
      sidecarLastModified > metadata.updatedAt;
    const metadataPatch: SidecarMetadataPatch = sidecarMetadataIsNewer && sidecar
      ? {
          ...(sidecar.rating === undefined ? {} : { rating: sidecar.rating }),
          ...(sidecar.colorLabel === undefined ? {} : { colorLabel: sidecar.colorLabel }),
        }
      : {};
    const hasMetadataPatch = Object.keys(metadataPatch).length > 0;
    const snapshot = session.snapshot();
    const canHydrateDocument =
      sidecarDocumentIsNewer &&
      snapshot.documentRevision === snapshot.persistedDocumentRevision;
    const sidecarProcess = sidecar
      ? openDevelopSessionDocument(sidecar.document)
      : null;
    if (canHydrateDocument && sidecar) {
      const hydrated = session.hydrate(sidecarProcess!);
      adapters.onSessionChanged(hydrated);
    }
    const mirroredDocument = canHydrateDocument && sidecarProcess?.kind === "editable"
      ? sidecarProcess.document
      : null;
    if (mirroredDocument || hasMetadataPatch) {
      await adapters.mirrorCatalog({
        ...(mirroredDocument ? { document: mirroredDocument } : {}),
        sourceUpdatedAt: sidecarLastModified,
        metadataPatch,
      });
    }
    if (hasMetadataPatch) {
      adapters.onSessionChanged(session.markMetadataHydrated());
    }

    const localStateWasClean =
      snapshot.documentRevision === snapshot.persistedDocumentRevision &&
      snapshot.metadataRevision === snapshot.persistedMetadataRevision;
    const catalogDocumentIsNewer = metadata.developUpdatedAt > sidecarLastModified;
    const catalogMetadataIsNewer = metadata.updatedAt > sidecarLastModified;
    if (
      !localStateWasClean ||
      (!catalogDocumentIsNewer && !catalogMetadataIsNewer)
    ) {
      return;
    }
    const catalogProcess = this.catalogDocument(metadata);
    if (
      catalogProcess.kind === "read-only-newer" ||
      sidecarProcess?.kind === "read-only-newer"
    ) {
      return;
    }
    const resolvedDocument = sidecarDocumentIsNewer && sidecarProcess
      ? sidecarProcess.document
      : catalogProcess.document;
    const resolvedMetadata = sidecarMetadataIsNewer && sidecar
      ? {
          rating: sidecar.rating ?? metadata.rating,
          colorLabel: sidecar.colorLabel === undefined
            ? metadata.colorLabel
            : sidecar.colorLabel,
        }
      : {
          rating: metadata.rating,
          colorLabel: metadata.colorLabel,
        };
    await this.#writeReconciledSidecar(
      resolvedDocument,
      resolvedMetadata,
      sidecar,
      Math.max(metadata.developUpdatedAt, metadata.updatedAt),
    );
  }

  async #writeReconciledSidecar(
    document: PersistedDevelopDocument,
    metadata: Pick<EntryMetadata, "rating" | "colorLabel">,
    sidecar: DevelopSidecar | null,
    sourceUpdatedAt: number,
  ): Promise<void> {
    const expectedContents = serializeDevelopXmp(
      document,
      metadata,
      sidecar?.contents ?? null,
    );
    if (sameSidecarContents(sidecar, expectedContents)) return;
    const journal: RecoveryJournal = {
      version: JOURNAL_VERSION,
      catalogId: this.#entry.catalogId,
      entryId: this.#entry.id,
      createdAt: Date.now(),
      sourceUpdatedAt,
      phase: "catalog-written",
      documentDirty: false,
      metadataDirty: false,
      document,
      metadata,
      existingContents: sidecar?.contents ?? null,
      expectedLastModified: sidecar?.lastModified ?? null,
    };
    writeJournal(this.#entry, journal);
    const written = await writeDevelopSidecar(
      this.#entry,
      document,
      metadata,
      journal.existingContents,
      journal.expectedLastModified,
    );
    this.#sidecarContents = written?.contents ?? null;
    this.#sidecarLastModified = written?.lastModified ?? null;
    clearJournal(this.#entry);
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
    const documentDirty =
      pending.snapshot.documentRevision !== pending.snapshot.persistedDocumentRevision;
    const metadataDirty =
      pending.snapshot.metadataRevision !== pending.snapshot.persistedMetadataRevision;
    if (!documentDirty && !metadataDirty) return;
    const sourceUpdatedAt = Date.now();
    serializeDevelopXmp(
      pending.snapshot.document,
      pending.metadata,
      this.#sidecarContents,
    );
    const journal: RecoveryJournal = {
      version: JOURNAL_VERSION,
      catalogId: this.#entry.catalogId,
      entryId: this.#entry.id,
      createdAt: sourceUpdatedAt,
      sourceUpdatedAt,
      phase: "prepared",
      documentDirty,
      metadataDirty,
      document: pending.snapshot.document,
      metadata: pending.metadata,
      existingContents: this.#sidecarContents,
      expectedLastModified: this.#sidecarLastModified,
    };
    writeJournal(this.#entry, journal);
    await adapters.mirrorCatalog({
      ...(documentDirty ? { document: pending.snapshot.document } : {}),
      sourceUpdatedAt,
      metadataPatch: metadataDirty ? pending.metadata : {},
    });
    writeJournal(this.#entry, { ...journal, phase: "catalog-written" });
    const written = await writeDevelopSidecar(
      this.#entry,
      pending.snapshot.document,
      pending.metadata,
      this.#sidecarContents,
      this.#sidecarLastModified,
    );
    this.#sidecarContents = written?.contents ?? null;
    this.#sidecarLastModified = written?.lastModified ?? null;
    clearJournal(this.#entry);
    this.#failedWrite = null;
    adapters.onSessionChanged(
      session.markPersisted(
        pending.snapshot.documentRevision,
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
    let recovered = journal;
    if (recovered.phase === "prepared") {
      await adapters.mirrorCatalog({
        ...(recovered.documentDirty ? { document: recovered.document } : {}),
        sourceUpdatedAt: recovered.sourceUpdatedAt,
        metadataPatch: recovered.metadataDirty ? recovered.metadata : {},
      });
      recovered = { ...recovered, phase: "catalog-written" };
      writeJournal(this.#entry, recovered);
    }
    const current = await readDevelopSidecar(this.#entry);
    const expectedContents = serializeDevelopXmp(
      recovered.document,
      recovered.metadata,
      recovered.existingContents,
    );
    if (!sameSidecarContents(current, expectedContents)) {
      const unchanged = recovered.expectedLastModified === null
        ? current === null
        : current?.lastModified === recovered.expectedLastModified;
      if (!unchanged) {
        throw new DevelopRepositoryError(
          "recovery-conflict",
          "The XMP sidecar changed during recovery. Resolve it before editing this photo.",
        );
      }
      const written = await writeDevelopSidecar(
        this.#entry,
        recovered.document,
        recovered.metadata,
        recovered.existingContents,
        recovered.expectedLastModified,
      );
      this.#sidecarContents = written?.contents ?? null;
      this.#sidecarLastModified = written?.lastModified ?? null;
    } else {
      this.#sidecarContents = current?.contents ?? null;
      this.#sidecarLastModified = current?.lastModified ?? null;
    }
    this.#sidecarContentsKnown = true;
    clearJournal(this.#entry);
  }

  async resolveDocument(metadata: EntryMetadata): Promise<DevelopSessionOpenDocument> {
    await this.flush();
    const journal = readJournal(this.#entry);
    if (journal) {
      if (!this.#adapters) {
        throw new DevelopRepositoryError(
          "recovery-adapter-unavailable",
          "Develop recovery needs the original catalog. Reopen it before exporting this photo.",
        );
      }
      await this.#recoverJournal();
    }
    const sidecar = await readDevelopSidecar(this.#entry);
    this.#sidecarContents = sidecar?.contents ?? null;
    this.#sidecarLastModified = sidecar?.lastModified ?? null;
    this.#sidecarContentsKnown = true;
    return openDevelopSessionDocument(
      resolveStoredDevelopDocument(sidecar, metadata),
    );
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
