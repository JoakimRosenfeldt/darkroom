"use client";

import { useEffect, useRef, useState } from "react";
import type { LibraryEntry } from "@/lib/fs/types";
import type { BasicSettings } from "@/lib/develop/types";
import { MAX_COMPONENTS_PER_MASK, MAX_MASKS } from "@/lib/develop/document";
import type { DevelopDocumentV3 } from "@/lib/develop/v3/document";
import { createDefaultLocalAdjustments, localAdjustmentDefinitions } from "@/lib/develop/v3/local-adjustments";
import {
  appendMaskSource,
  findMaskNode,
  maskSourceNodes,
  referencedMaskArtifacts,
  removeMaskNode,
  replaceMaskNode,
  ungroupMaskNode,
  wrapMaskNodeInGroup,
  type LocalMaskV3,
  type MaskExpression,
  type MaskSource,
  type MaskSourceNode,
} from "@/lib/develop/v3/masking";
import { AiMaskActions } from "./AiMaskActions";
import { ActionButton, SectionLabel, StatusCard, ToggleRow } from "./V3PanelControls";
import { SliderRow } from "./SliderRow";
import { useDevelopStore } from "@/stores/develop-store";

interface Props {
  readonly document: DevelopDocumentV3;
  readonly entry: LibraryEntry;
}

function nextName(masks: readonly LocalMaskV3[]): string {
  const names = new Set(masks.map((mask) => mask.name));
  let index = 1;
  while (names.has(`Mask ${index}`)) index += 1;
  return `Mask ${index}`;
}

function sourceNode(source: MaskSource): MaskSourceNode {
  return { kind: "source", id: crypto.randomUUID(), enabled: true, source };
}

function luminanceSource(): MaskSourceNode {
  return sourceNode({ kind: "luminance-range", minimum: 0.25, maximum: 0.75, feather: 0.1, algorithm: "linear-rec709-v1" });
}

function labelForSource(source: MaskSource): string {
  switch (source.kind) {
    case "brush": return source.autoMask.kind === "off" ? "Brush" : "Brush Auto Mask, Prototype";
    case "linear-gradient": return "Linear gradient";
    case "radial-gradient": return "Radial gradient";
    case "luminance-range": return "Luminance Range";
    case "color-range": return "Color Range";
    case "depth-range": return "Depth Range, Prototype";
    case "ai-matte": return source.selector === "subject" ? "Subject matte" : "Sky matte";
    default: { const exhaustive: never = source; return exhaustive; }
  }
}

function basicField(field: ReturnType<typeof localAdjustmentDefinitions>[number]["field"]): keyof BasicSettings | null {
  switch (field) {
    case "exposure": case "contrast": case "highlights": case "shadows": case "whites":
    case "blacks": case "temperature": case "tint": case "vibrance": case "saturation":
      return field;
    case "texture": case "clarity": case "sharpness": case "noise": case "moire":
    case "defringe": case "colorizeAmount": return null;
    default: { const exhaustive: never = field; return exhaustive; }
  }
}

function hexColor(color: readonly [number, number, number]): string {
  return `#${color.map((channel) => Math.round(channel * 255).toString(16).padStart(2, "0")).join("")}`;
}

function colorFromHex(value: string): readonly [number, number, number] {
  const parsed = /^#[0-9a-f]{6}$/i.test(value) ? Number.parseInt(value.slice(1), 16) : 0x808080;
  return [(parsed >> 16 & 255) / 255, (parsed >> 8 & 255) / 255, (parsed & 255) / 255];
}

function MaskNameInput({
  name,
  onPreview,
}: {
  readonly name: string;
  readonly onPreview: (name: string) => void;
}) {
  const [draft, setDraft] = useState(name);
  const original = useRef(name);
  const editing = useRef(false);
  const beginEditGroup = useDevelopStore((state) => state.beginEditGroup);
  const endEditGroup = useDevelopStore((state) => state.endEditGroup);
  const cancelEditGroup = useDevelopStore((state) => state.cancelEditGroup);

  useEffect(() => {
    if (!editing.current) setDraft(name);
  }, [name]);

  const begin = () => {
    if (editing.current) return;
    editing.current = true;
    original.current = name;
    beginEditGroup("Rename mask");
  };

  const commit = () => {
    if (!editing.current) return;
    editing.current = false;
    endEditGroup();
  };

  const cancel = () => {
    if (!editing.current) return;
    editing.current = false;
    setDraft(original.current);
    cancelEditGroup();
  };

  return (
    <input
      value={draft}
      aria-label="Mask name"
      onFocus={begin}
      onChange={(event) => {
        begin();
        setDraft(event.target.value);
        onPreview(event.target.value);
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          cancel();
          event.currentTarget.blur();
        } else if (event.key === "Enter") {
          event.preventDefault();
          commit();
          event.currentTarget.blur();
        }
      }}
      className="w-full rounded border border-lr-border-subtle bg-lr-panel px-2 py-1 text-[10px] text-lr-text"
    />
  );
}

function PreviewColorInput({
  label,
  value,
  onPreview,
}: {
  readonly label: string;
  readonly value: string;
  readonly onPreview: (value: string) => void;
}) {
  const editing = useRef(false);
  const beginEditGroup = useDevelopStore((state) => state.beginEditGroup);
  const endEditGroup = useDevelopStore((state) => state.endEditGroup);
  const cancelEditGroup = useDevelopStore((state) => state.cancelEditGroup);

  const begin = () => {
    if (editing.current) return;
    editing.current = true;
    beginEditGroup(label);
  };
  const commit = () => {
    if (!editing.current) return;
    editing.current = false;
    endEditGroup();
  };
  const cancel = () => {
    if (!editing.current) return;
    editing.current = false;
    cancelEditGroup();
  };

  return (
    <input
      type="color"
      aria-label={label}
      value={value}
      onFocus={begin}
      onPointerDown={begin}
      onPointerCancel={cancel}
      onChange={(event) => {
        begin();
        onPreview(event.target.value);
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          cancel();
          event.currentTarget.blur();
        } else if (event.key === "Enter") {
          commit();
          event.currentTarget.blur();
        }
      }}
    />
  );
}

function ExpressionTree({
  expression,
  selectedId,
  onSelect,
  onReplace,
  onRemove,
}: {
  readonly expression: MaskExpression;
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  readonly onReplace: (node: MaskExpression) => void;
  readonly onRemove: (id: string) => void;
}) {
  const selected = expression.id === selectedId;
  return (
    <div className={`rounded border p-1.5 ${selected ? "border-lr-accent/70 bg-lr-selection/30" : "border-lr-border-subtle"}`}>
      <div className="flex items-center gap-1">
        <button type="button" className="min-w-0 flex-1 truncate text-left text-[10px] text-lr-text-muted" onClick={() => onSelect(expression.id)}>
          {expression.kind === "source" ? labelForSource(expression.source) : expression.kind === "invert" ? "Invert" : `Group, ${expression.operation}`}
        </button>
        <input type="checkbox" aria-label="Enable mask node" checked={expression.enabled} onChange={(event) => onReplace({ ...expression, enabled: event.target.checked })} className="size-3 accent-lr-accent" />
        <button type="button" className="text-[9px] text-lr-text-faint hover:text-lr-danger" onClick={() => onRemove(expression.id)}>Delete</button>
      </div>
      {expression.kind === "combine" ? (
        <>
          <select value={expression.operation} onChange={(event) => onReplace({ ...expression, operation: event.target.value === "subtract" ? "subtract" : event.target.value === "intersect" ? "intersect" : "add" })} className="mt-1 w-full rounded border border-lr-border-subtle bg-lr-panel px-1 py-1 text-[9px] text-lr-text">
            <option value="add">Add</option><option value="subtract">Subtract</option><option value="intersect">Intersect</option>
          </select>
          <div className="mt-1 space-y-1 border-l border-lr-border-subtle pl-2">
            <ExpressionTree expression={expression.left} selectedId={selectedId} onSelect={onSelect} onReplace={onReplace} onRemove={onRemove} />
            <ExpressionTree expression={expression.right} selectedId={selectedId} onSelect={onSelect} onReplace={onReplace} onRemove={onRemove} />
          </div>
        </>
      ) : expression.kind === "invert" ? (
        <div className="mt-1 border-l border-lr-border-subtle pl-2"><ExpressionTree expression={expression.child} selectedId={selectedId} onSelect={onSelect} onReplace={onReplace} onRemove={onRemove} /></div>
      ) : null}
    </div>
  );
}

export function MaskExpressionEditor({ document, entry }: Props) {
  const dispatch = useDevelopStore((state) => state.dispatchV3);
  const reset = useDevelopStore((state) => state.resetV3Group);
  const ui = useDevelopStore((state) => state.activeEntryId ? state.sessions[state.activeEntryId]?.ui ?? null : null);
  const setSelectedMask = useDevelopStore((state) => state.setSelectedMask);
  const setSelectedNode = useDevelopStore((state) => state.setSelectedComponent);
  const setTool = useDevelopStore((state) => state.setMaskTool);
  const setOverlay = useDevelopStore((state) => state.setMaskOverlayVisible);
  const masks = document.local.masks;
  const selectedMask = masks.find((mask) => mask.id === ui?.selectedMaskId) ?? null;
  const selectedNode = selectedMask && ui?.selectedComponentId ? findMaskNode(selectedMask.expression, ui.selectedComponentId) : null;

  const writeMasks = (next: readonly LocalMaskV3[], label: string): void => {
    const used = new Set(next.flatMap((mask) => referencedMaskArtifacts(mask.expression).map((asset) => asset.assetId)));
    dispatch({ kind: "replace-v3-semantic-group", group: "local", value: { ...document.local, masks: next, maskAssetRefs: document.local.maskAssetRefs.filter((asset) => used.has(asset.assetId)) } }, label);
  };
  const writeMask = (next: LocalMaskV3, label: string): void => writeMasks(masks.map((mask) => mask.id === next.id ? next : mask), label);
  const addSource = (node: MaskSourceNode): void => {
    if (selectedMask) {
      if (maskSourceNodes(selectedMask.expression).length >= MAX_COMPONENTS_PER_MASK) return;
      writeMask({ ...selectedMask, expression: appendMaskSource(selectedMask.expression, node, "add", crypto.randomUUID()) }, "Add mask source");
    } else if (masks.length < MAX_MASKS) {
      const mask = { id: crypto.randomUUID(), name: nextName(masks), enabled: true, expression: node, adjustments: createDefaultLocalAdjustments() } satisfies LocalMaskV3;
      writeMasks([...masks, mask], "Add mask");
      setSelectedMask(mask.id);
    }
    setSelectedNode(node.id);
    setOverlay(true);
  };
  const replaceNode = (node: MaskExpression): void => {
    if (selectedMask) writeMask({ ...selectedMask, expression: replaceMaskNode(selectedMask.expression, node.id, node) }, "Edit mask node");
  };
  const removeNode = (id: string): void => {
    if (!selectedMask) return;
    const expression = removeMaskNode(selectedMask.expression, id);
    if (expression) writeMask({ ...selectedMask, expression }, "Delete mask node");
    else writeMasks(masks.filter((mask) => mask.id !== selectedMask.id), "Delete mask");
    setSelectedNode(null);
  };
  const depth = document.local.maskAssetRefs.find((asset) => asset.kind === "depth-map") ?? null;
  const selectedSource = selectedNode?.kind === "source" ? selectedNode.source : null;
  const selectedAutoMask = selectedSource?.kind === "brush" && selectedSource.autoMask.kind === "auto-mask-prototype-v1"
    ? selectedSource.autoMask
    : null;

  return (
    <div>
      <AiMaskActions entry={entry} document={document} />
      <div className="mb-2 flex flex-wrap gap-1">
        <ActionButton onClick={() => { setSelectedMask(null); setSelectedNode(null); setTool("brush"); setOverlay(true); }}>New brush mask</ActionButton>
        <ActionButton onClick={() => { setTool("linear-gradient"); setOverlay(true); }}>Draw linear</ActionButton>
        <ActionButton onClick={() => { setTool("radial-gradient"); setOverlay(true); }}>Draw radial</ActionButton>
        <ActionButton onClick={() => addSource(luminanceSource())}>Luminance Range</ActionButton>
        <ActionButton onClick={() => addSource(sourceNode({ kind: "color-range", samples: [[0.5, 0.5, 0.5]], tolerance: 0.25, feather: 0.1, algorithm: "working-rgb-distance-v1" }))}>Color Range</ActionButton>
        <ActionButton disabled={!depth} onClick={() => depth && addSource(sourceNode({ kind: "depth-range", asset: depth, source: { entryId: entry.id, catalogId: entry.catalogId, assetRevision: entry.assetRevision, relativePath: entry.relativePath, size: entry.size, lastModified: entry.lastModified }, minimum: 0.25, maximum: 0.75, feather: 0.1, algorithm: "prototype-depth-map-v1" }))}>Depth Range, Prototype</ActionButton>
      </div>
      {!depth ? <p className="mb-2 text-[9px] text-lr-text-faint">Depth Range unavailable. Create and accept a Prototype Depth artifact first.</p> : null}
      {masks.length === 0 ? <StatusCard title="No masks">Choose a source or draw on the photo.</StatusCard> : (
        <div className="space-y-2">
          {masks.map((mask) => <div key={mask.id} className="rounded-md border border-lr-border-subtle p-2">
            <div className="flex items-center gap-1">
              <button type="button" onClick={() => { setSelectedMask(mask.id); setSelectedNode(mask.expression.id); }} className="min-w-0 flex-1 truncate text-left text-[11px] text-lr-text">{mask.name}</button>
              <input type="checkbox" aria-label={`Enable ${mask.name}`} checked={mask.enabled} onChange={(event) => writeMask({ ...mask, enabled: event.target.checked }, "Toggle mask")} className="size-3 accent-lr-accent" />
              <button type="button" onClick={() => writeMasks(masks.filter((item) => item.id !== mask.id), "Delete mask")} className="text-[9px] text-lr-danger">Delete</button>
            </div>
            {selectedMask?.id === mask.id ? <div className="mt-2 space-y-2">
              <MaskNameInput
                key={`${entry.id}:${mask.id}:name`}
                name={mask.name}
                onPreview={(name) => writeMask({ ...mask, name }, "Rename mask")}
              />
              <div className="flex flex-wrap gap-1">
                <ActionButton onClick={() => writeMask({ ...mask, expression: mask.expression.kind === "invert" ? mask.expression.child : { kind: "invert", id: crypto.randomUUID(), enabled: true, child: mask.expression } }, "Invert mask")}>{mask.expression.kind === "invert" ? "Remove invert" : "Invert"}</ActionButton>
                <ActionButton disabled={!selectedNode} onClick={() => selectedNode && writeMask({ ...mask, expression: wrapMaskNodeInGroup(mask.expression, selectedNode.id, luminanceSource(), "intersect", crypto.randomUUID()) }, "Group mask nodes")}>Group with range</ActionButton>
                <ActionButton disabled={selectedNode?.kind !== "combine"} onClick={() => selectedNode && writeMask({ ...mask, expression: ungroupMaskNode(mask.expression, selectedNode.id) }, "Remove grouped sibling")}>Keep first child</ActionButton>
              </div>
              <ExpressionTree expression={mask.expression} selectedId={ui?.selectedComponentId ?? null} onSelect={setSelectedNode} onReplace={replaceNode} onRemove={removeNode} />
            </div> : null}
          </div>)}
        </div>
      )}
      {selectedNode?.kind === "source" && selectedSource?.kind === "brush" ? <div className="mt-3 border-t border-lr-border-subtle pt-2">
        <ToggleRow label="Auto Mask, Prototype" checked={selectedSource.autoMask.kind !== "off"} onChange={(enabled) => replaceNode({ ...selectedNode, source: { ...selectedSource, autoMask: enabled ? { kind: "auto-mask-prototype-v1", samplePolicy: "explicit-working-rgb", samples: [[0.5, 0.5, 0.5]], radius: 0.25, algorithm: "analysis-color-edge-v1" } : { kind: "off" } } })} />
        {selectedAutoMask ? <>
          <label className="flex items-center justify-between text-[10px] text-lr-text-muted">Sample <PreviewColorInput key={`${entry.id}:${selectedNode.id}:auto-mask-sample`} label="Adjust Auto Mask sample" value={hexColor(selectedAutoMask.samples[0] ?? [0.5, 0.5, 0.5])} onPreview={(value) => replaceNode({ ...selectedNode, source: { ...selectedSource, autoMask: { ...selectedAutoMask, samplePolicy: "explicit-working-rgb", samples: [colorFromHex(value)] } } })} /></label>
          <SliderRow label="Analysis radius" value={selectedAutoMask.radius} min={0.001} max={1} step={0.01} onChange={(radius) => replaceNode({ ...selectedNode, source: { ...selectedSource, autoMask: { ...selectedAutoMask, radius } } })} />
          <p className="text-[9px] text-lr-text-faint">Prototype analysis is required. It never falls back to an ordinary brush.</p>
        </> : null}
      </div> : null}
      {selectedNode?.kind === "source" && selectedSource?.kind === "luminance-range" ? <div className="mt-3 border-t border-lr-border-subtle pt-2">
        <SectionLabel>Luminance Range</SectionLabel>
        <SliderRow label="Minimum" value={selectedSource.minimum} min={0} max={selectedSource.maximum} step={0.01} onChange={(minimum) => replaceNode({ ...selectedNode, source: { ...selectedSource, minimum } })} />
        <SliderRow label="Maximum" value={selectedSource.maximum} min={selectedSource.minimum} max={1} step={0.01} onChange={(maximum) => replaceNode({ ...selectedNode, source: { ...selectedSource, maximum } })} />
        <SliderRow label="Feather" value={selectedSource.feather} min={0} max={1} step={0.01} onChange={(feather) => replaceNode({ ...selectedNode, source: { ...selectedSource, feather } })} />
      </div> : null}
      {selectedNode?.kind === "source" && selectedSource?.kind === "color-range" ? <div className="mt-3 border-t border-lr-border-subtle pt-2">
        <SectionLabel>Color Range</SectionLabel>
        <label className="flex items-center justify-between text-[10px] text-lr-text-muted">Sample <PreviewColorInput key={`${entry.id}:${selectedNode.id}:color-range-sample`} label="Adjust Color Range sample" value={hexColor(selectedSource.samples[0] ?? [0.5, 0.5, 0.5])} onPreview={(value) => replaceNode({ ...selectedNode, source: { ...selectedSource, samples: [colorFromHex(value)] } })} /></label>
        <SliderRow label="Tolerance" value={selectedSource.tolerance} min={0.001} max={2} step={0.01} onChange={(tolerance) => replaceNode({ ...selectedNode, source: { ...selectedSource, tolerance } })} />
        <SliderRow label="Feather" value={selectedSource.feather} min={0} max={1} step={0.01} onChange={(feather) => replaceNode({ ...selectedNode, source: { ...selectedSource, feather } })} />
      </div> : null}
      {selectedNode?.kind === "source" && selectedSource?.kind === "depth-range" ? <div className="mt-3 border-t border-lr-border-subtle pt-2">
        <SectionLabel>Depth Range, Prototype</SectionLabel>
        <SliderRow label="Near" value={selectedSource.minimum} min={0} max={selectedSource.maximum} step={0.01} onChange={(minimum) => replaceNode({ ...selectedNode, source: { ...selectedSource, minimum } })} />
        <SliderRow label="Far" value={selectedSource.maximum} min={selectedSource.minimum} max={1} step={0.01} onChange={(maximum) => replaceNode({ ...selectedNode, source: { ...selectedSource, maximum } })} />
        <SliderRow label="Feather" value={selectedSource.feather} min={0} max={1} step={0.01} onChange={(feather) => replaceNode({ ...selectedNode, source: { ...selectedSource, feather } })} />
      </div> : null}
      {selectedMask ? <div className="mt-3 border-t border-lr-border-subtle pt-2">
        <SectionLabel>Local adjustments</SectionLabel>
        {localAdjustmentDefinitions().map((definition) => {
          const prototype = ["texture", "clarity", "sharpness", "noise", "moire", "defringe"].includes(definition.field);
          const basic = basicField(definition.field);
          const value = definition.field === "colorizeAmount"
            ? selectedMask.adjustments.colorize.amount
            : basic
              ? selectedMask.adjustments.basic[basic]
              : definition.field === "texture" ? selectedMask.adjustments.texture
                : definition.field === "clarity" ? selectedMask.adjustments.clarity
                  : definition.field === "sharpness" ? selectedMask.adjustments.sharpness
                    : definition.field === "noise" ? selectedMask.adjustments.noise
                      : definition.field === "moire" ? selectedMask.adjustments.moire
                        : definition.field === "defringe" ? selectedMask.adjustments.defringe : 0;
          return <SliderRow key={definition.field} label={`${definition.label}${prototype ? ", Prototype" : ""}`} value={value} min={definition.minimum} max={definition.maximum} step={definition.field === "exposure" ? 0.05 : 1} onChange={(next) => {
            const adjustments = definition.field === "colorizeAmount"
              ? { ...selectedMask.adjustments, colorize: { ...selectedMask.adjustments.colorize, amount: next } }
              : basic
                ? { ...selectedMask.adjustments, basic: { ...selectedMask.adjustments.basic, [basic]: next } }
                : { ...selectedMask.adjustments, [definition.field]: next };
            writeMask({ ...selectedMask, adjustments }, `Adjust mask ${definition.field}`);
          }} />;
        })}
        <label className="mt-1 flex items-center justify-between text-[10px] text-lr-text-muted">Colorize color <PreviewColorInput key={`${entry.id}:${selectedMask.id}:colorize`} label="Adjust mask colorize color" value={hexColor(selectedMask.adjustments.colorize.color)} onPreview={(value) => writeMask({ ...selectedMask, adjustments: { ...selectedMask.adjustments, colorize: { ...selectedMask.adjustments.colorize, color: colorFromHex(value) } } }, "Adjust mask colorize color")} /></label>
      </div> : null}
      <button type="button" onClick={() => reset("local")} className="mt-3 text-[9px] text-lr-text-faint hover:text-lr-text">Reset masks</button>
      <span className="ml-2 font-mono text-[9px] text-lr-text-faint">{masks.length}/{MAX_MASKS}</span>
    </div>
  );
}
