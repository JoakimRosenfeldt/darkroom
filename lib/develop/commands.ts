import { DEFAULT_DEVELOP_SETTINGS } from "@/lib/develop/registry";
import {
  MAX_COMPONENTS_PER_MASK,
  MAX_MASKS,
  validateDevelopDocument,
} from "@/lib/develop/document";
import type {
  BasicSettings,
  DevelopDocument,
  DevelopSettings,
  GlobalDevelopPluginId,
  AiMaskComponent,
  LocalMask,
  MaskComponent,
  MaskRasterAsset,
  MaskingSettings,
  NonEmpty,
} from "@/lib/develop/types";

export type ReplaceGlobalCommand = {
  [K in GlobalDevelopPluginId]: {
    kind: "replace-global";
    pluginId: K;
    value: DevelopSettings[K];
  };
}[GlobalDevelopPluginId];

export type DevelopCommand =
  | ReplaceGlobalCommand
  | { kind: "reset-plugin"; pluginId: GlobalDevelopPluginId }
  | { kind: "reset-all" }
  | { kind: "insert-mask"; index: number; mask: LocalMask; assets?: readonly MaskRasterAsset[] }
  | { kind: "rename-mask"; maskId: string; name: string }
  | { kind: "duplicate-mask"; maskId: string; newMaskId: string; newComponentIds: readonly string[]; index?: number }
  | { kind: "move-mask"; maskId: string; toIndex: number }
  | { kind: "set-mask-enabled"; maskId: string; enabled: boolean }
  | { kind: "set-mask-inverted"; maskId: string; inverted: boolean }
  | { kind: "insert-mask-component"; maskId: string; index: number; component: MaskComponent }
  | { kind: "replace-mask-component"; maskId: string; component: MaskComponent }
  | { kind: "remove-mask-component"; maskId: string; componentId: string }
  | { kind: "set-mask-component-operation"; maskId: string; componentId: string; operation: "add" | "subtract" }
  | { kind: "set-mask-adjustments"; maskId: string; adjustments: BasicSettings }
  | { kind: "replace-mask"; mask: LocalMask; assets?: readonly MaskRasterAsset[] }
  | { kind: "remove-mask"; maskId: string }
  | { kind: "set-mask-assets"; assets: readonly MaskRasterAsset[] }
  | {
      kind: "complete-ai-mask";
      maskId: string | null;
      newMask: LocalMask | null;
      component: AiMaskComponent;
      asset: MaskRasterAsset;
    }
  | {
      kind: "update-ai-mask";
      maskId: string;
      componentId: string;
      component: AiMaskComponent;
      asset: MaskRasterAsset;
    };

type GlobalPatch = {
  [K in GlobalDevelopPluginId]: {
    kind: "global";
    pluginId: K;
    before: DevelopSettings[K];
    after: DevelopSettings[K];
  };
}[GlobalDevelopPluginId];

export type DevelopPatch =
  | GlobalPatch
  | { kind: "masking"; before: MaskingSettings; after: MaskingSettings }
  | { kind: "asset"; assetId: string; before: MaskRasterAsset | null; after: MaskRasterAsset | null };

export type PatchGroup = readonly [DevelopPatch, ...DevelopPatch[]];

export type CommandResult =
  | { changed: false; document: DevelopDocument }
  | { changed: true; document: DevelopDocument; patches: PatchGroup };

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function replaceGlobal(
  document: DevelopDocument,
  patch: GlobalPatch,
  direction: "forward" | "backward",
): DevelopDocument {
  switch (patch.pluginId) {
    case "basic": {
      const value = direction === "forward" ? patch.after : patch.before;
      return { ...document, settings: { ...document.settings, basic: value } };
    }
    case "crop": {
      const value = direction === "forward" ? patch.after : patch.before;
      return { ...document, settings: { ...document.settings, crop: value } };
    }
    case "curve": {
      const value = direction === "forward" ? patch.after : patch.before;
      return { ...document, settings: { ...document.settings, curve: value } };
    }
    case "mixer": {
      const value = direction === "forward" ? patch.after : patch.before;
      return { ...document, settings: { ...document.settings, mixer: value } };
    }
    case "effects": {
      const value = direction === "forward" ? patch.after : patch.before;
      return { ...document, settings: { ...document.settings, effects: value } };
    }
    default: {
      const exhaustive: never = patch;
      return exhaustive;
    }
  }
}

export function applyDevelopPatch(
  document: DevelopDocument,
  patch: DevelopPatch,
  direction: "forward" | "backward",
): DevelopDocument {
  switch (patch.kind) {
    case "global":
      return replaceGlobal(document, patch, direction);
    case "masking":
      return {
        ...document,
        settings: {
          ...document.settings,
          masking: direction === "forward" ? patch.after : patch.before,
        },
      };
    case "asset": {
      const asset = direction === "forward" ? patch.after : patch.before;
      const maskAssets = { ...document.maskAssets };
      if (asset) maskAssets[patch.assetId] = asset;
      else delete maskAssets[patch.assetId];
      return { ...document, maskAssets };
    }
    default: {
      const exhaustive: never = patch;
      return exhaustive;
    }
  }
}

export function replayDevelopPatches(
  document: DevelopDocument,
  patches: readonly DevelopPatch[],
  direction: "forward" | "backward",
): DevelopDocument {
  const ordered = direction === "forward" ? patches : [...patches].reverse();
  return ordered.reduce(
    (current, patch) => applyDevelopPatch(current, patch, direction),
    document,
  );
}

function patchResult(document: DevelopDocument, patch: DevelopPatch | null): CommandResult {
  return patch ? applyPatches(document, [patch]) : { changed: false, document };
}

function assetPatches(
  document: DevelopDocument,
  assets: readonly MaskRasterAsset[] = [],
): DevelopPatch[] {
  return assets.flatMap<DevelopPatch>((asset) => {
    const before = document.maskAssets[asset.id] ?? null;
    return equal(before, asset) ? [] : [{ kind: "asset", assetId: asset.id, before, after: asset }];
  });
}

function referencedAssetIds(masking: MaskingSettings): Set<string> {
  const ids = new Set<string>();
  for (const mask of masking.masks) {
    for (const component of mask.components) {
      if (component.kind === "ai") ids.add(component.assetId);
    }
  }
  return ids;
}

function maskAt(document: DevelopDocument, maskId: string): LocalMask | undefined {
  return document.settings.masking.masks.find((mask) => mask.id === maskId);
}

function updateMask(
  document: DevelopDocument,
  maskId: string,
  update: (mask: LocalMask) => LocalMask,
): CommandResult {
  const current = maskAt(document, maskId);
  if (!current) return { changed: false, document };
  const next = update(current);
  if (equal(current, next)) return { changed: false, document };
  const masks = document.settings.masking.masks.map((mask) => mask.id === maskId ? next : mask);
  return applyPatches(document, [{
    kind: "masking",
    before: document.settings.masking,
    after: { masks },
  }]);
}

function removeUnreferencedAssets(
  document: DevelopDocument,
  nextMasking: MaskingSettings,
): DevelopPatch[] {
  const referenced = referencedAssetIds(nextMasking);
  return Object.entries(document.maskAssets).flatMap<DevelopPatch>(([assetId, before]) =>
    referenced.has(assetId) ? [] : [{ kind: "asset", assetId, before, after: null }],
  );
}

function nonEmptyComponents(components: MaskComponent[]): NonEmpty<MaskComponent> | null {
  const first = components[0];
  return first ? [first, ...components.slice(1)] : null;
}

function applyPatches(
  document: DevelopDocument,
  patches: DevelopPatch[],
): CommandResult {
  const first = patches[0];
  if (!first) return { changed: false, document };
  const group: PatchGroup = [first, ...patches.slice(1)];
  const nextDocument = replayDevelopPatches(document, group, "forward");
  validateDevelopDocument(nextDocument);
  return {
    changed: true,
    document: nextDocument,
    patches: group,
  };
}

export function applyDevelopCommand(
  document: DevelopDocument,
  command: DevelopCommand,
): CommandResult {
  switch (command.kind) {
    case "replace-global": {
      switch (command.pluginId) {
        case "basic":
          return patchResult(document, equal(document.settings.basic, command.value) ? null : { kind: "global", pluginId: "basic", before: document.settings.basic, after: command.value });
        case "crop":
          return patchResult(document, equal(document.settings.crop, command.value) ? null : { kind: "global", pluginId: "crop", before: document.settings.crop, after: command.value });
        case "curve":
          return patchResult(document, equal(document.settings.curve, command.value) ? null : { kind: "global", pluginId: "curve", before: document.settings.curve, after: command.value });
        case "mixer":
          return patchResult(document, equal(document.settings.mixer, command.value) ? null : { kind: "global", pluginId: "mixer", before: document.settings.mixer, after: command.value });
        case "effects":
          return patchResult(document, equal(document.settings.effects, command.value) ? null : { kind: "global", pluginId: "effects", before: document.settings.effects, after: command.value });
        default: {
          const exhaustive: never = command;
          return exhaustive;
        }
      }
    }
    case "reset-plugin": {
      switch (command.pluginId) {
        case "basic":
          return patchResult(document, equal(document.settings.basic, DEFAULT_DEVELOP_SETTINGS.basic) ? null : { kind: "global", pluginId: "basic", before: document.settings.basic, after: structuredClone(DEFAULT_DEVELOP_SETTINGS.basic) });
        case "crop":
          return patchResult(document, equal(document.settings.crop, DEFAULT_DEVELOP_SETTINGS.crop) ? null : { kind: "global", pluginId: "crop", before: document.settings.crop, after: structuredClone(DEFAULT_DEVELOP_SETTINGS.crop) });
        case "curve":
          return patchResult(document, equal(document.settings.curve, DEFAULT_DEVELOP_SETTINGS.curve) ? null : { kind: "global", pluginId: "curve", before: document.settings.curve, after: structuredClone(DEFAULT_DEVELOP_SETTINGS.curve) });
        case "mixer":
          return patchResult(document, equal(document.settings.mixer, DEFAULT_DEVELOP_SETTINGS.mixer) ? null : { kind: "global", pluginId: "mixer", before: document.settings.mixer, after: structuredClone(DEFAULT_DEVELOP_SETTINGS.mixer) });
        case "effects":
          return patchResult(document, equal(document.settings.effects, DEFAULT_DEVELOP_SETTINGS.effects) ? null : { kind: "global", pluginId: "effects", before: document.settings.effects, after: structuredClone(DEFAULT_DEVELOP_SETTINGS.effects) });
        default: {
          const exhaustive: never = command;
          return exhaustive;
        }
      }
    }
    case "reset-all": {
      const patches: Array<DevelopPatch | null> = [
        equal(document.settings.basic, DEFAULT_DEVELOP_SETTINGS.basic) ? null : { kind: "global", pluginId: "basic", before: document.settings.basic, after: structuredClone(DEFAULT_DEVELOP_SETTINGS.basic) },
        equal(document.settings.crop, DEFAULT_DEVELOP_SETTINGS.crop) ? null : { kind: "global", pluginId: "crop", before: document.settings.crop, after: structuredClone(DEFAULT_DEVELOP_SETTINGS.crop) },
        equal(document.settings.curve, DEFAULT_DEVELOP_SETTINGS.curve) ? null : { kind: "global", pluginId: "curve", before: document.settings.curve, after: structuredClone(DEFAULT_DEVELOP_SETTINGS.curve) },
        equal(document.settings.mixer, DEFAULT_DEVELOP_SETTINGS.mixer) ? null : { kind: "global", pluginId: "mixer", before: document.settings.mixer, after: structuredClone(DEFAULT_DEVELOP_SETTINGS.mixer) },
        equal(document.settings.effects, DEFAULT_DEVELOP_SETTINGS.effects) ? null : { kind: "global", pluginId: "effects", before: document.settings.effects, after: structuredClone(DEFAULT_DEVELOP_SETTINGS.effects) },
        equal(document.settings.masking, DEFAULT_DEVELOP_SETTINGS.masking)
          ? null
          : { kind: "masking", before: document.settings.masking, after: { masks: [] } },
        ...Object.entries(document.maskAssets).map(([assetId, before]) => ({
          kind: "asset" as const,
          assetId,
          before,
          after: null,
        })),
      ];
      return applyPatches(document, patches.filter((patch): patch is DevelopPatch => patch !== null));
    }
    case "insert-mask": {
      if (document.settings.masking.masks.length >= MAX_MASKS) return { changed: false, document };
      if (document.settings.masking.masks.some((mask) => mask.id === command.mask.id)) {
        return { changed: false, document };
      }
      const masks = [...document.settings.masking.masks];
      masks.splice(Math.max(0, Math.min(command.index, masks.length)), 0, command.mask);
      return applyPatches(document, [...assetPatches(document, command.assets), {
        kind: "masking",
        before: document.settings.masking,
        after: { masks },
      }]);
    }
    case "rename-mask":
      return updateMask(document, command.maskId, (mask) => ({
        ...mask,
        name: command.name.trim() || mask.name,
      }));
    case "duplicate-mask": {
      if (document.settings.masking.masks.length >= MAX_MASKS) return { changed: false, document };
      const source = maskAt(document, command.maskId);
      if (!source || document.settings.masking.masks.some((mask) => mask.id === command.newMaskId)) {
        return { changed: false, document };
      }
      if (command.newComponentIds.length !== source.components.length ||
        new Set(command.newComponentIds).size !== command.newComponentIds.length ||
        command.newComponentIds.some((id) => !id)) {
        return { changed: false, document };
      }
      const copiedComponents = source.components.map((component, index) => ({
        ...component,
        id: command.newComponentIds[index]!,
      }));
      const duplicateComponents = nonEmptyComponents(copiedComponents);
      if (!duplicateComponents) return { changed: false, document };
      const duplicate: LocalMask = {
        ...structuredClone(source),
        id: command.newMaskId,
        name: `${source.name} copy`,
        components: duplicateComponents,
      };
      const sourceIndex = document.settings.masking.masks.findIndex((mask) => mask.id === command.maskId);
      const masks = [...document.settings.masking.masks];
      const targetIndex = Math.max(0, Math.min(command.index ?? sourceIndex + 1, masks.length));
      masks.splice(targetIndex, 0, duplicate);
      return applyPatches(document, [{
        kind: "masking",
        before: document.settings.masking,
        after: { masks },
      }]);
    }
    case "move-mask": {
      const currentIndex = document.settings.masking.masks.findIndex((mask) => mask.id === command.maskId);
      if (currentIndex < 0) return { changed: false, document };
      const targetIndex = Math.max(0, Math.min(command.toIndex, document.settings.masking.masks.length - 1));
      if (targetIndex === currentIndex) return { changed: false, document };
      const masks = [...document.settings.masking.masks];
      const [mask] = masks.splice(currentIndex, 1);
      if (!mask) return { changed: false, document };
      masks.splice(targetIndex, 0, mask);
      return applyPatches(document, [{
        kind: "masking",
        before: document.settings.masking,
        after: { masks },
      }]);
    }
    case "set-mask-enabled":
      return updateMask(document, command.maskId, (mask) => ({ ...mask, enabled: command.enabled }));
    case "set-mask-inverted":
      return updateMask(document, command.maskId, (mask) => ({ ...mask, inverted: command.inverted }));
    case "insert-mask-component":
      return updateMask(document, command.maskId, (mask) => {
        if (mask.components.length >= MAX_COMPONENTS_PER_MASK) return mask;
        if (mask.components.some((component) => component.id === command.component.id)) return mask;
        if (command.index <= 0 && command.component.operation !== "add") return mask;
        const components = [...mask.components];
        const index = Math.max(0, Math.min(command.index, components.length));
        components.splice(index, 0, command.component);
        const nextComponents = nonEmptyComponents(components);
        return nextComponents ? { ...mask, components: nextComponents } : mask;
      });
    case "replace-mask-component":
      return updateMask(document, command.maskId, (mask) => {
        const index = mask.components.findIndex((component) => component.id === command.component.id);
        if (index < 0 || (index === 0 && command.component.operation !== "add")) return mask;
        const components = [...mask.components];
        components[index] = command.component;
        const nextComponents = nonEmptyComponents(components);
        return nextComponents ? { ...mask, components: nextComponents } : mask;
      });
    case "remove-mask-component": {
      const current = maskAt(document, command.maskId);
      if (!current || current.components.length <= 1) return { changed: false, document };
      const index = current.components.findIndex((component) => component.id === command.componentId);
      if (index < 0) return { changed: false, document };
      const components = current.components.filter((component) => component.id !== command.componentId);
      if (index === 0) {
        const first = components[0];
        if (!first) return { changed: false, document };
        components[0] = first.operation === "add" ? first : { ...first, operation: "add" };
      }
      const nextComponents = nonEmptyComponents(components);
      if (!nextComponents) return { changed: false, document };
      const nextMask = { ...current, components: nextComponents };
      const nextMasking = {
        masks: document.settings.masking.masks.map((mask) =>
          mask.id === current.id ? nextMask : mask,
        ),
      };
      return applyPatches(document, [
        { kind: "masking", before: document.settings.masking, after: nextMasking },
        ...removeUnreferencedAssets(document, nextMasking),
      ]);
    }
    case "set-mask-component-operation":
      return updateMask(document, command.maskId, (mask) => {
        const index = mask.components.findIndex((component) => component.id === command.componentId);
        if (index < 0 || (index === 0 && command.operation !== "add")) return mask;
        const component = mask.components[index]!;
        if (component.operation === command.operation) return mask;
        const components = [...mask.components];
        components[index] = { ...component, operation: command.operation };
        const nextComponents = nonEmptyComponents(components);
        return nextComponents ? { ...mask, components: nextComponents } : mask;
      });
    case "set-mask-adjustments":
      return updateMask(document, command.maskId, (mask) => ({
        ...mask,
        adjustments: command.adjustments,
      }));
    case "replace-mask": {
      const index = document.settings.masking.masks.findIndex((mask) => mask.id === command.mask.id);
      if (index < 0 || equal(document.settings.masking.masks[index], command.mask)) {
        return { changed: false, document };
      }
      const masks = [...document.settings.masking.masks];
      masks[index] = command.mask;
      const nextMasking = { masks };
      const removedAssets = removeUnreferencedAssets(document, nextMasking);
      return applyPatches(document, [
        ...assetPatches(document, command.assets),
        { kind: "masking", before: document.settings.masking, after: nextMasking },
        ...removedAssets,
      ]);
    }
    case "remove-mask": {
      const masks = document.settings.masking.masks.filter((mask) => mask.id !== command.maskId);
      if (masks.length === document.settings.masking.masks.length) return { changed: false, document };
      const nextMasking = { masks };
      const removedAssets = removeUnreferencedAssets(document, nextMasking);
      return applyPatches(document, [
        { kind: "masking", before: document.settings.masking, after: nextMasking },
        ...removedAssets,
      ]);
    }
    case "set-mask-assets": {
      const patches = assetPatches(document, command.assets);
      return applyPatches(document, patches);
    }
    case "complete-ai-mask": {
      if (command.component.kind !== "ai" || command.component.assetId !== command.asset.id) {
        return { changed: false, document };
      }
      const selectedMask = command.maskId ? maskAt(document, command.maskId) : undefined;
      if (command.maskId && !selectedMask) return { changed: false, document };

      if (selectedMask) {
        if (selectedMask.components.length >= MAX_COMPONENTS_PER_MASK) {
          return { changed: false, document };
        }
        if (selectedMask.components.some((component) => component.id === command.component.id)) {
          return { changed: false, document };
        }
        const nextMask: LocalMask = {
          ...selectedMask,
          components: [...selectedMask.components, { ...command.component, operation: "add" }],
        };
        const masking = {
          masks: document.settings.masking.masks.map((mask) =>
            mask.id === selectedMask.id ? nextMask : mask,
          ),
        };
        return applyPatches(document, [
          ...assetPatches(document, [command.asset]),
          { kind: "masking", before: document.settings.masking, after: masking },
        ]);
      }

      if (!command.newMask || document.settings.masking.masks.length >= MAX_MASKS) {
        return { changed: false, document };
      }
      if (
        command.newMask.components.length !== 1 ||
        command.newMask.components[0]?.id !== command.component.id ||
        command.newMask.components[0]?.kind !== "ai"
      ) {
        return { changed: false, document };
      }
      if (document.settings.masking.masks.some((mask) => mask.id === command.newMask?.id)) {
        return { changed: false, document };
      }
      const newMask: LocalMask = {
        ...command.newMask,
        components: [{ ...command.component, operation: "add" }],
      };
      return applyPatches(document, [
        ...assetPatches(document, [command.asset]),
        {
          kind: "masking",
          before: document.settings.masking,
          after: { masks: [...document.settings.masking.masks, newMask] },
        },
      ]);
    }
    case "update-ai-mask": {
      if (command.component.kind !== "ai" || command.component.assetId !== command.asset.id) {
        return { changed: false, document };
      }
      const currentMask = maskAt(document, command.maskId);
      const currentIndex = currentMask?.components.findIndex(
        (component) => component.id === command.componentId,
      ) ?? -1;
      const current = currentMask?.components[currentIndex];
      if (!currentMask || !current || current.kind !== "ai") {
        return { changed: false, document };
      }
      const nextComponent: AiMaskComponent = {
        ...command.component,
        id: current.id,
        operation: current.operation,
      };
      if (equal(current, nextComponent)) return { changed: false, document };
      const nextComponents = nonEmptyComponents(currentMask.components.map((component, index) =>
        index === currentIndex ? nextComponent : component,
      ));
      if (!nextComponents) return { changed: false, document };
      const nextMask: LocalMask = {
        ...currentMask,
        components: nextComponents,
      };
      const masking = {
        masks: document.settings.masking.masks.map((mask) =>
          mask.id === currentMask.id ? nextMask : mask,
        ),
      };
      return applyPatches(document, [
        ...assetPatches(document, [command.asset]),
        { kind: "masking", before: document.settings.masking, after: masking },
        ...removeUnreferencedAssets(document, masking),
      ]);
    }
    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }
}
