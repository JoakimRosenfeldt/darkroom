import { decodePersistedDevelopDocument } from "./codec";
import {
  createDefaultV3DevelopDocument,
  type DevelopDocumentV3,
  type PersistedCrop,
} from "./document";
import type { GeneratedAcceptanceResult } from "./generated-jobs";

export const V3_SEMANTIC_GROUP_IDS = [
  "tone",
  "color",
  "optics",
  "geometry",
  "local",
  "cleanup",
  "presence",
  "detail",
  "effects",
  "lensBlur",
  "hdr",
] as const;

export type V3SemanticGroupId = (typeof V3_SEMANTIC_GROUP_IDS)[number];

export type ReplaceV3SemanticGroupCommand = {
  [K in V3SemanticGroupId]: {
    readonly kind: "replace-v3-semantic-group";
    readonly group: K;
    readonly value: DevelopDocumentV3[K];
  };
}[V3SemanticGroupId];

export type PatchV3SemanticGroupCommand = {
  [K in V3SemanticGroupId]: {
    readonly kind: "patch-v3-semantic-group";
    readonly group: K;
    readonly patch: Partial<DevelopDocumentV3[K]>;
  };
}[V3SemanticGroupId];

export type V3DirectEditCommand =
  | ReplaceV3SemanticGroupCommand
  | PatchV3SemanticGroupCommand
  | { readonly kind: "reset-v3-semantic-group"; readonly group: V3SemanticGroupId }
  | { readonly kind: "reset-v3-all" }
  | { readonly kind: "commit-v3-crop-draft"; readonly crop: PersistedCrop };

export type V3EditCommand =
  | V3DirectEditCommand
  | {
      readonly kind: "accept-v3-job-result";
      readonly result: Extract<GeneratedAcceptanceResult, { readonly kind: "accepted" }>;
      readonly edit: V3DirectEditCommand;
    };

export type V3GroupPatch = {
  [K in V3SemanticGroupId]: {
    readonly kind: "v3-semantic-group";
    readonly group: K;
    readonly before: DevelopDocumentV3[K];
    readonly after: DevelopDocumentV3[K];
  };
}[V3SemanticGroupId];

export type V3CommandResult =
  | { readonly changed: false; readonly document: DevelopDocumentV3 }
  | {
      readonly changed: true;
      readonly document: DevelopDocumentV3;
      readonly patches: readonly [V3GroupPatch, ...V3GroupPatch[]];
    };

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function validateV3CommandDocument(value: unknown): DevelopDocumentV3 {
  const decoded = decodePersistedDevelopDocument(value);
  if (decoded.kind !== "editable" || decoded.document.version !== 3) {
    const reason = decoded.kind === "invalid"
      ? decoded.message
      : "The command did not produce an editable v3 document.";
    throw new Error(reason);
  }
  return decoded.document;
}

function groupPatch(
  before: DevelopDocumentV3,
  after: DevelopDocumentV3,
  group: V3SemanticGroupId,
): V3GroupPatch {
  switch (group) {
    case "tone":
      return { kind: "v3-semantic-group", group, before: before.tone, after: after.tone };
    case "color":
      return { kind: "v3-semantic-group", group, before: before.color, after: after.color };
    case "optics":
      return { kind: "v3-semantic-group", group, before: before.optics, after: after.optics };
    case "geometry":
      return { kind: "v3-semantic-group", group, before: before.geometry, after: after.geometry };
    case "local":
      return { kind: "v3-semantic-group", group, before: before.local, after: after.local };
    case "cleanup":
      return { kind: "v3-semantic-group", group, before: before.cleanup, after: after.cleanup };
    case "presence":
      return { kind: "v3-semantic-group", group, before: before.presence, after: after.presence };
    case "detail":
      return { kind: "v3-semantic-group", group, before: before.detail, after: after.detail };
    case "effects":
      return { kind: "v3-semantic-group", group, before: before.effects, after: after.effects };
    case "lensBlur":
      return { kind: "v3-semantic-group", group, before: before.lensBlur, after: after.lensBlur };
    case "hdr":
      return { kind: "v3-semantic-group", group, before: before.hdr, after: after.hdr };
    default: {
      const exhaustive: never = group;
      return exhaustive;
    }
  }
}

function replaceGroup(
  document: DevelopDocumentV3,
  group: V3SemanticGroupId,
  value: unknown,
): DevelopDocumentV3 {
  return validateV3CommandDocument({ ...document, [group]: value });
}

function groupValue(
  document: DevelopDocumentV3,
  group: V3SemanticGroupId,
): DevelopDocumentV3[V3SemanticGroupId] {
  switch (group) {
    case "tone": return document.tone;
    case "color": return document.color;
    case "optics": return document.optics;
    case "geometry": return document.geometry;
    case "local": return document.local;
    case "cleanup": return document.cleanup;
    case "presence": return document.presence;
    case "detail": return document.detail;
    case "effects": return document.effects;
    case "lensBlur": return document.lensBlur;
    case "hdr": return document.hdr;
    default: {
      const exhaustive: never = group;
      return exhaustive;
    }
  }
}

function changedResult(
  before: DevelopDocumentV3,
  after: DevelopDocumentV3,
  groups: readonly V3SemanticGroupId[],
): V3CommandResult {
  const patches = groups.flatMap((group) =>
    equal(groupValue(before, group), groupValue(after, group))
      ? []
      : [groupPatch(before, after, group)],
  );
  const first = patches[0];
  return first
    ? { changed: true, document: after, patches: [first, ...patches.slice(1)] }
    : { changed: false, document: before };
}

function applyDirectV3Command(
  document: DevelopDocumentV3,
  command: V3DirectEditCommand,
): V3CommandResult {
  switch (command.kind) {
    case "replace-v3-semantic-group": {
      const next = replaceGroup(document, command.group, command.value);
      return changedResult(document, next, [command.group]);
    }
    case "patch-v3-semantic-group": {
      const current = groupValue(document, command.group);
      const next = replaceGroup(
        document,
        command.group,
        Object.assign({}, current, command.patch),
      );
      return changedResult(document, next, [command.group]);
    }
    case "reset-v3-semantic-group": {
      const defaults = createDefaultV3DevelopDocument();
      const value = command.group === "local"
        ? { ...defaults.local, geometryFrame: document.local.geometryFrame }
        : groupValue(defaults, command.group);
      const next = replaceGroup(document, command.group, value);
      return changedResult(document, next, [command.group]);
    }
    case "reset-v3-all": {
      const defaults = createDefaultV3DevelopDocument();
      const next = validateV3CommandDocument({
        ...defaults,
        compatibility: document.compatibility,
      });
      return changedResult(document, next, V3_SEMANTIC_GROUP_IDS);
    }
    case "commit-v3-crop-draft": {
      const next = replaceGroup(document, "geometry", {
        ...document.geometry,
        crop: command.crop,
      });
      return changedResult(document, next, ["geometry"]);
    }
    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }
}

export function applyV3EditCommand(
  document: DevelopDocumentV3,
  command: V3EditCommand,
): V3CommandResult {
  if (command.kind !== "accept-v3-job-result") {
    return applyDirectV3Command(document, command);
  }
  const edited = applyDirectV3Command(document, command.edit);
  const referenced = new Map(
    [
      ...edited.document.local.maskAssetRefs,
      ...edited.document.cleanup.components.flatMap((component) =>
        component.kind === "repair" && component.source.kind === "accepted-patch"
          ? [component.source.asset]
          : []
      ),
      ...(edited.document.lensBlur.kind === "enabled"
        ? [edited.document.lensBlur.depthAsset]
        : []),
    ].map((reference) => [reference.assetId, reference]),
  );
  for (const accepted of command.result.assetRefs) {
    const actual = referenced.get(accepted.assetId);
    if (
      !actual ||
      actual.kind !== accepted.kind ||
      actual.sha256 !== accepted.sha256 ||
      actual.producerRevision !== accepted.producerRevision ||
      actual.coordinateFrameRevision !== accepted.coordinateFrameRevision ||
      actual.colorStageId !== accepted.colorStageId
    ) {
      throw new Error(
        `Accepted asset ${accepted.assetId} is not referenced by its semantic owner.`,
      );
    }
  }
  return edited;
}

export function replayV3Patches(
  document: DevelopDocumentV3,
  patches: readonly V3GroupPatch[],
  direction: "forward" | "backward",
): DevelopDocumentV3 {
  const ordered = direction === "forward" ? patches : [...patches].reverse();
  return ordered.reduce(
    (current, patch) => replaceGroup(
      current,
      patch.group,
      direction === "forward" ? patch.after : patch.before,
    ),
    document,
  );
}

export function mergeV3GroupPatches(
  current: readonly V3GroupPatch[],
  next: readonly V3GroupPatch[],
): V3GroupPatch[] {
  const before = new Map(current.map((patch) => [patch.group, patch]));
  const after = new Map(next.map((patch) => [patch.group, patch]));
  const groups = [...new Set([...before.keys(), ...after.keys()])];
  return groups.map((group) => {
    const first = before.get(group) ?? after.get(group);
    const last = after.get(group) ?? before.get(group);
    if (!first || !last) throw new Error("V3 history patch is incomplete.");
    return mergePatchPair(first, last);
  });
}

function mergePatchPair(
  first: V3GroupPatch,
  last: V3GroupPatch,
): V3GroupPatch {
  switch (first.group) {
    case "tone":
      if (last.group !== "tone") throw new Error("V3 history groups do not match.");
      return { ...first, after: last.after };
    case "color":
      if (last.group !== "color") throw new Error("V3 history groups do not match.");
      return { ...first, after: last.after };
    case "optics":
      if (last.group !== "optics") throw new Error("V3 history groups do not match.");
      return { ...first, after: last.after };
    case "geometry":
      if (last.group !== "geometry") throw new Error("V3 history groups do not match.");
      return { ...first, after: last.after };
    case "local":
      if (last.group !== "local") throw new Error("V3 history groups do not match.");
      return { ...first, after: last.after };
    case "cleanup":
      if (last.group !== "cleanup") throw new Error("V3 history groups do not match.");
      return { ...first, after: last.after };
    case "presence":
      if (last.group !== "presence") throw new Error("V3 history groups do not match.");
      return { ...first, after: last.after };
    case "detail":
      if (last.group !== "detail") throw new Error("V3 history groups do not match.");
      return { ...first, after: last.after };
    case "effects":
      if (last.group !== "effects") throw new Error("V3 history groups do not match.");
      return { ...first, after: last.after };
    case "lensBlur":
      if (last.group !== "lensBlur") throw new Error("V3 history groups do not match.");
      return { ...first, after: last.after };
    case "hdr":
      if (last.group !== "hdr") throw new Error("V3 history groups do not match.");
      return { ...first, after: last.after };
    default: {
      const exhaustive: never = first;
      return exhaustive;
    }
  }
}
