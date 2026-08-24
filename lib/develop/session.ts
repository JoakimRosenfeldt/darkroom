import type { EntryMetadata } from "@/lib/catalog/types";
import {
  applyDevelopCommand,
  replayDevelopPatches,
  type DevelopCommand,
  type DevelopPatch,
} from "@/lib/develop/commands";
import {
  renderFrozenV2,
  type FrozenV2ExportRequest,
  type FrozenV2PrepareRequest,
  type FrozenV2PreviewRequest,
} from "@/lib/develop/frozen-v2-backend";
import type {
  DevelopDocument,
  GlobalDevelopPluginId,
} from "@/lib/develop/types";
import type {
  RawExportRenderResult,
} from "@/lib/export/types";
import type { RenderPreparation } from "@/lib/develop/renderer";

const HISTORY_LIMIT = 100;

export type DevelopMetadataValues = Pick<
  EntryMetadata,
  "pick" | "rating" | "colorLabel"
>;

export type DevelopHistoryEntry =
  | {
      readonly kind: "document";
      readonly label: string;
      readonly patches: readonly DevelopPatch[];
      readonly editGroup: string | null;
    }
  | {
      readonly kind: "metadata";
      readonly label: string;
      readonly before: DevelopMetadataValues;
      readonly after: DevelopMetadataValues;
    };

export interface DevelopSessionSnapshot {
  readonly catalogId: string;
  readonly entryId: string;
  readonly document: DevelopDocument;
  readonly documentRevision: number;
  readonly persistedDocumentRevision: number;
  readonly metadataRevision: number;
  readonly persistedMetadataRevision: number;
  readonly undo: readonly DevelopHistoryEntry[];
  readonly redo: readonly DevelopHistoryEntry[];
  readonly transientEdit: { readonly id: string; readonly label: string } | null;
}

export interface DevelopSaveResult {
  readonly status: "scheduled" | "saved";
  readonly documentRevision: number;
  readonly metadataRevision: number;
}

export interface DevelopSessionRepository {
  save(snapshot: DevelopSessionSnapshot): Promise<DevelopSaveResult>;
}

export interface DevelopMetadataMutation {
  readonly entryId: string;
  readonly values: DevelopMetadataValues;
}

export interface DevelopSession {
  readonly catalogId: string;
  readonly entryId: string;
  snapshot(): DevelopSessionSnapshot;
  dispatch(command: DevelopCommand, label?: string): DevelopSessionSnapshot;
  render(request: FrozenV2PrepareRequest): Promise<RenderPreparation>;
  render(request: FrozenV2PreviewRequest): Promise<RenderPreparation>;
  render(request: FrozenV2ExportRequest): Promise<RawExportRenderResult>;
  save(): Promise<DevelopSaveResult>;
}

interface MutableDevelopSessionState {
  document: DevelopDocument;
  documentRevision: number;
  persistedDocumentRevision: number;
  metadataRevision: number;
  persistedMetadataRevision: number;
  undo: DevelopHistoryEntry[];
  redo: DevelopHistoryEntry[];
  transientEdit: { id: string; label: string } | null;
}

function metadataValues(metadata: DevelopMetadataValues): DevelopMetadataValues {
  return {
    pick: metadata.pick,
    rating: metadata.rating,
    colorLabel: metadata.colorLabel,
  };
}

function boundedHistory(entries: DevelopHistoryEntry[]): DevelopHistoryEntry[] {
  return entries.length > HISTORY_LIMIT
    ? entries.slice(entries.length - HISTORY_LIMIT)
    : entries;
}

function patchTarget(patch: DevelopPatch): string {
  switch (patch.kind) {
    case "global":
      return `global:${patch.pluginId}`;
    case "masking":
      return "masking";
    case "asset":
      return `asset:${patch.assetId}`;
    default: {
      const exhaustive: never = patch;
      return exhaustive;
    }
  }
}

function mergePatch(current: DevelopPatch, next: DevelopPatch): DevelopPatch {
  switch (current.kind) {
    case "masking":
      return next.kind === "masking" ? { ...current, after: next.after } : current;
    case "asset":
      return next.kind === "asset" && next.assetId === current.assetId
        ? { ...current, after: next.after }
        : current;
    case "global": {
      if (next.kind !== "global" || next.pluginId !== current.pluginId) return current;
      switch (current.pluginId) {
        case "basic":
          return next.pluginId === "basic" ? { ...current, after: next.after } : current;
        case "crop":
          return next.pluginId === "crop" ? { ...current, after: next.after } : current;
        case "curve":
          return next.pluginId === "curve" ? { ...current, after: next.after } : current;
        case "mixer":
          return next.pluginId === "mixer" ? { ...current, after: next.after } : current;
        case "effects":
          return next.pluginId === "effects" ? { ...current, after: next.after } : current;
        default: {
          const exhaustive: never = current;
          return exhaustive;
        }
      }
    }
    default: {
      const exhaustive: never = current;
      return exhaustive;
    }
  }
}

function mergeGroupedPatches(
  current: readonly DevelopPatch[],
  next: readonly DevelopPatch[],
): DevelopPatch[] {
  const merged = [...current];
  const targetIndexes = new Map(
    merged.map((patch, index) => [patchTarget(patch), index]),
  );
  for (const patch of next) {
    const target = patchTarget(patch);
    const index = targetIndexes.get(target);
    if (index === undefined) {
      targetIndexes.set(target, merged.length);
      merged.push(patch);
      continue;
    }
    const existing = merged[index];
    if (existing) merged[index] = mergePatch(existing, patch);
  }
  return merged;
}

export function createDevelopPluginCommand(
  document: DevelopDocument,
  pluginId: GlobalDevelopPluginId,
  patch: unknown,
): DevelopCommand {
  const values = typeof patch === "object" && patch !== null ? patch : {};
  switch (pluginId) {
    case "basic":
      return {
        kind: "replace-global",
        pluginId,
        value: Object.assign({}, document.settings.basic, values),
      };
    case "crop":
      return {
        kind: "replace-global",
        pluginId,
        value: Object.assign({}, document.settings.crop, values),
      };
    case "curve":
      return {
        kind: "replace-global",
        pluginId,
        value: Object.assign({}, document.settings.curve, values),
      };
    case "mixer":
      return {
        kind: "replace-global",
        pluginId,
        value: Object.assign({}, document.settings.mixer, values),
      };
    case "effects":
      return {
        kind: "replace-global",
        pluginId,
        value: Object.assign({}, document.settings.effects, values),
      };
    default: {
      const exhaustive: never = pluginId;
      return exhaustive;
    }
  }
}

export class V2DevelopSession implements DevelopSession {
  readonly catalogId: string;
  readonly entryId: string;
  #state: MutableDevelopSessionState;
  #repository: DevelopSessionRepository | null;

  constructor(
    catalogId: string,
    entryId: string,
    document: DevelopDocument,
    repository: DevelopSessionRepository | null = null,
  ) {
    this.catalogId = catalogId;
    this.entryId = entryId;
    this.#repository = repository;
    this.#state = {
      document,
      documentRevision: 0,
      persistedDocumentRevision: 0,
      metadataRevision: 0,
      persistedMetadataRevision: 0,
      undo: [],
      redo: [],
      transientEdit: null,
    };
  }

  attachRepository(repository: DevelopSessionRepository): void {
    this.#repository = repository;
  }

  snapshot(): DevelopSessionSnapshot {
    return {
      catalogId: this.catalogId,
      entryId: this.entryId,
      ...this.#state,
      undo: [...this.#state.undo],
      redo: [...this.#state.redo],
    };
  }

  hydrate(document: DevelopDocument): DevelopSessionSnapshot {
    if (this.#state.documentRevision !== this.#state.persistedDocumentRevision) {
      return this.snapshot();
    }
    this.#state = {
      ...this.#state,
      document,
      documentRevision: this.#state.documentRevision + 1,
      persistedDocumentRevision: this.#state.persistedDocumentRevision + 1,
      undo: this.#state.undo.filter((entry) => entry.kind === "metadata"),
      redo: this.#state.redo.filter((entry) => entry.kind === "metadata"),
      transientEdit: null,
    };
    return this.snapshot();
  }

  dispatch(command: DevelopCommand, label = "Edit"): DevelopSessionSnapshot {
    const result = applyDevelopCommand(this.#state.document, command);
    if (!result.changed) return this.snapshot();
    const editGroup = this.#state.transientEdit?.id ?? null;
    const previous = this.#state.undo.at(-1);
    if (editGroup && previous?.kind === "document" && previous.editGroup === editGroup) {
      this.#state.undo[this.#state.undo.length - 1] = {
        ...previous,
        patches: mergeGroupedPatches(previous.patches, result.patches),
      };
    } else {
      this.#state.undo = boundedHistory([
        ...this.#state.undo,
        {
          kind: "document",
          label: this.#state.transientEdit?.label ?? label,
          patches: result.patches,
          editGroup,
        },
      ]);
    }
    this.#state.document = result.document;
    this.#state.documentRevision += 1;
    this.#state.redo = [];
    return this.snapshot();
  }

  beginEditGroup(label: string): DevelopSessionSnapshot {
    if (!this.#state.transientEdit) {
      this.#state.transientEdit = { id: crypto.randomUUID(), label };
    }
    return this.snapshot();
  }

  endEditGroup(): DevelopSessionSnapshot {
    this.#state.transientEdit = null;
    return this.snapshot();
  }

  undo(): DevelopMetadataMutation | null {
    const history = this.#state.undo.pop();
    if (!history) return null;
    this.#state.redo.push(history);
    this.#state.transientEdit = null;
    if (history.kind === "document") {
      this.#state.documentRevision += 1;
      this.#state.document = replayDevelopPatches(
        this.#state.document,
        history.patches,
        "backward",
      );
      return null;
    }
    this.#state.metadataRevision += 1;
    return { entryId: this.entryId, values: history.before };
  }

  redo(): DevelopMetadataMutation | null {
    const history = this.#state.redo.pop();
    if (!history) return null;
    this.#state.undo = boundedHistory([...this.#state.undo, history]);
    this.#state.transientEdit = null;
    if (history.kind === "document") {
      this.#state.documentRevision += 1;
      this.#state.document = replayDevelopPatches(
        this.#state.document,
        history.patches,
        "forward",
      );
      return null;
    }
    this.#state.metadataRevision += 1;
    return { entryId: this.entryId, values: history.after };
  }

  recordMetadataEdit(
    before: DevelopMetadataValues,
    after: DevelopMetadataValues,
  ): DevelopSessionSnapshot {
    const beforeMetadata = metadataValues(before);
    const afterMetadata = metadataValues(after);
    if (JSON.stringify(beforeMetadata) === JSON.stringify(afterMetadata)) {
      return this.snapshot();
    }
    this.#state.undo = boundedHistory([
      ...this.#state.undo,
      {
        kind: "metadata",
        label: "Edit metadata",
        before: beforeMetadata,
        after: afterMetadata,
      },
    ]);
    this.#state.redo = [];
    this.#state.metadataRevision += 1;
    return this.snapshot();
  }

  markMetadataHydrated(): DevelopSessionSnapshot {
    this.#state.persistedMetadataRevision = this.#state.metadataRevision;
    return this.snapshot();
  }

  markPersisted(
    documentRevision: number,
    metadataRevision: number,
  ): DevelopSessionSnapshot {
    if (
      documentRevision >= this.#state.persistedDocumentRevision &&
      documentRevision <= this.#state.documentRevision &&
      metadataRevision >= this.#state.persistedMetadataRevision &&
      metadataRevision <= this.#state.metadataRevision
    ) {
      this.#state.persistedDocumentRevision = documentRevision;
      this.#state.persistedMetadataRevision = metadataRevision;
    }
    return this.snapshot();
  }

  render(request: FrozenV2PrepareRequest): Promise<RenderPreparation>;
  render(request: FrozenV2PreviewRequest): Promise<RenderPreparation>;
  render(request: FrozenV2ExportRequest): Promise<RawExportRenderResult>;
  render(
    request: FrozenV2PrepareRequest | FrozenV2PreviewRequest | FrozenV2ExportRequest,
  ): Promise<RenderPreparation | RawExportRenderResult> {
    switch (request.kind) {
      case "prepare":
        return renderFrozenV2(this.#state.document, request);
      case "preview":
        return renderFrozenV2(this.#state.document, request);
      case "export":
        return renderFrozenV2(this.#state.document, request);
      default: {
        const exhaustive: never = request;
        return exhaustive;
      }
    }
  }

  save(): Promise<DevelopSaveResult> {
    if (!this.#repository) {
      return Promise.reject(
        new Error(`Develop session ${this.entryId} has no persistence repository.`),
      );
    }
    return this.#repository.save(this.snapshot());
  }
}

const sessions = new Map<string, V2DevelopSession>();
let activeSessionKey: string | null = null;

function sessionKey(catalogId: string, entryId: string): string {
  return JSON.stringify([catalogId, entryId]);
}

export function getOrCreateDevelopSession(
  catalogId: string,
  entryId: string,
  document: DevelopDocument,
): V2DevelopSession {
  const key = sessionKey(catalogId, entryId);
  const existing = sessions.get(key);
  if (existing) return existing;
  const session = new V2DevelopSession(catalogId, entryId, document);
  sessions.set(key, session);
  return session;
}

export function getDevelopSession(
  catalogId: string,
  entryId: string,
): V2DevelopSession | null {
  return sessions.get(sessionKey(catalogId, entryId)) ?? null;
}

export function activateDevelopSession(catalogId: string, entryId: string): void {
  activeSessionKey = sessionKey(catalogId, entryId);
}

export function getActiveDevelopSession(
  catalogId: string,
  entryId: string,
): V2DevelopSession | null {
  const key = sessionKey(catalogId, entryId);
  return activeSessionKey === key ? sessions.get(key) ?? null : null;
}

export function clearDevelopSessions(): void {
  sessions.clear();
  activeSessionKey = null;
}
