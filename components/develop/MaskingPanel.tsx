"use client";

import { useRef, useState, type ReactNode } from "react";
import {
  IconChevronDown,
  IconChevronUp,
  IconCopy,
  IconEye,
  IconEyeOff,
  IconPlus,
  IconTrash,
} from "@/components/shell/icons";
import {
  COLOR_SLIDER_TRACKS,
  SliderRow,
} from "@/components/develop/SliderRow";
import { MAX_COMPONENTS_PER_MASK, MAX_MASKS } from "@/lib/develop/document";
import type {
  BasicSettings,
  LocalMask,
  MaskComponent,
  MaskOperation,
  RadialGradientMaskComponent,
} from "@/lib/develop/types";
import { useDevelopStore } from "@/stores/develop-store";

export type MaskTool = "none" | "brush" | "linear-gradient" | "radial-gradient";

interface MaskingPanelProps {
  aiActions?: ReactNode;
  onDone: () => void;
}

const TOOL_LABELS: Record<Exclude<MaskTool, "none">, string> = {
  brush: "Brush",
  "linear-gradient": "Linear",
  "radial-gradient": "Radial",
};

const TOOL_SHORTCUTS: Record<Exclude<MaskTool, "none">, string> = {
  brush: "K",
  "linear-gradient": "M",
  "radial-gradient": "Shift+M",
};

function componentLabel(component: MaskComponent): string {
  switch (component.kind) {
    case "brush":
      return "Brush";
    case "linear-gradient":
      return "Linear gradient";
    case "radial-gradient":
      return "Radial gradient";
    case "ai":
      return `${component.selector === "subject" ? "Subject" : "Sky"} mask`;
    default: {
      const exhaustive: never = component;
      return exhaustive;
    }
  }
}

function maskSummary(mask: LocalMask): string {
  const primary = mask.components[0];
  const kind = primary ? componentLabel(primary) : "Empty mask";
  const extra = mask.components.length > 1 ? ` · ${mask.components.length} parts` : "";
  return `${kind}${extra}`;
}

function adjustmentSummary(mask: LocalMask): string {
  const exposure = mask.adjustments.exposure;
  if (exposure !== 0) return `${exposure > 0 ? "+" : ""}${exposure.toFixed(2)} EV`;
  const saturation = mask.adjustments.saturation;
  if (saturation !== 0) return `${saturation > 0 ? "+" : ""}${saturation} sat`;
  return "0";
}

export function MaskingPanel({ aiActions, onDone }: MaskingPanelProps) {
  const session = useDevelopStore((state) => {
    const entryId = state.activeEntryId;
    return entryId ? state.sessions[entryId] ?? null : null;
  });
  const dispatch = useDevelopStore((state) => state.dispatch);
  const setSelectedMask = useDevelopStore((state) => state.setSelectedMask);
  const setSelectedComponent = useDevelopStore((state) => state.setSelectedComponent);
  const setOverlayVisible = useDevelopStore((state) => state.setMaskOverlayVisible);
  const setTool = useDevelopStore((state) => state.setMaskTool);
  const hiddenOverlayEntryRef = useRef<string | null>(null);

  const document = session?.document;
  const masks = document?.settings.masking.masks ?? [];
  const selectedMaskId = session?.ui.selectedMaskId ?? null;
  const selectedComponentId = session?.ui.selectedComponentId ?? null;
  const selectedMask = masks.find((mask) => mask.id === selectedMaskId) ?? null;
  const selectedComponent = selectedMask?.components.find((component) => component.id === selectedComponentId) ?? null;
  const activeTool = session?.ui.tool ?? "none";
  function selectMask(mask: LocalMask) {
    setSelectedMask(mask.id);
    setSelectedComponent(mask.components[0]?.id ?? null);
    setTool("none");
  }

  function addMask() {
    if (masks.length >= MAX_MASKS) return;
    setSelectedMask(null);
    setSelectedComponent(null);
    setTool("brush");
    setOverlayVisible(true);
  }

  function activateTool(kind: Exclude<MaskTool, "none">, addComponent = false) {
    const currentState = useDevelopStore.getState();
    const activeEntryId = currentState.activeEntryId;
    const mask = activeEntryId
      ? currentState.sessions[activeEntryId]?.document.settings.masking.masks.find((item) => item.id === selectedMaskId)
      : undefined;
    if (!mask) {
      if (masks.length >= MAX_MASKS) return;
      setSelectedMask(null);
      setSelectedComponent(null);
      setOverlayVisible(true);
      setTool(kind);
      return;
    }

    const currentComponent = mask.components.find((component) => component.id === selectedComponentId);
    if (addComponent || !currentComponent || currentComponent.kind !== kind) {
      if (mask.components.length >= MAX_COMPONENTS_PER_MASK) return;
      setSelectedComponent(null);
    }
    setSelectedMask(mask.id);
    setOverlayVisible(true);
    setTool(kind);
  }

  function updateSelectedComponent(component: MaskComponent) {
    if (!selectedMask) return;
    dispatch({ kind: "replace-mask-component", maskId: selectedMask.id, component }, `Adjust ${componentLabel(component)}`);
  }

  function deleteSelectedMask() {
    if (!selectedMask) return;
    const index = masks.findIndex((mask) => mask.id === selectedMask.id);
    const next = masks[index + 1] ?? masks[index - 1] ?? null;
    dispatch(
      { kind: "remove-mask", maskId: selectedMask.id },
      "Delete mask",
    );
    setSelectedMask(next?.id ?? null);
    setSelectedComponent(next?.components[0]?.id ?? null);
    setTool("none");
  }

  function beginLocalAdjustment(): void {
    if (hiddenOverlayEntryRef.current !== null) return;
    const state = useDevelopStore.getState();
    const entryId = state.activeEntryId;
    if (!entryId || !state.sessions[entryId]?.ui.overlayVisible) return;
    hiddenOverlayEntryRef.current = entryId;
    setOverlayVisible(false);
  }

  function endLocalAdjustment(): void {
    const entryId = hiddenOverlayEntryRef.current;
    hiddenOverlayEntryRef.current = null;
    if (entryId && useDevelopStore.getState().activeEntryId === entryId) {
      setOverlayVisible(true);
    }
  }

  return (
    <aside className="flex w-[352px] shrink-0 flex-col border-l border-lr-border-subtle bg-lr-panel">
      <div className="flex min-h-[49px] items-center justify-between border-b border-lr-border-subtle px-4 py-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-lr-text-muted">
            Masks
          </h2>
          <span className="font-mono text-[10px] text-lr-text-faint">
            {masks.length}/{MAX_MASKS}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            title="Create mask"
            disabled={masks.length >= MAX_MASKS}
            onClick={addMask}
            className="flex h-7 items-center gap-1.5 rounded-[7px] bg-lr-accent px-2.5 text-[11px] font-medium text-[#14202a] transition hover:bg-lr-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            <IconPlus className="h-3.5 w-3.5" />
            Create mask
          </button>
        </div>
      </div>

      {masks.length >= MAX_MASKS ? (
        <p className="border-b border-lr-border-subtle bg-amber-950/25 px-4 py-2 text-[11px] text-amber-200">
          16-mask limit reached.
        </p>
      ) : null}

      {aiActions ? (
        <section className="border-b border-lr-border-subtle px-3 py-3">
          {aiActions}
        </section>
      ) : null}

      <div className="border-b border-lr-border-subtle p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-lr-text-muted">Classic tools</span>
          <button
            type="button"
            onClick={() => setTool("none")}
            aria-pressed={activeTool === "none"}
            className={`rounded px-2 py-1 text-[10px] ${activeTool === "none" ? "bg-lr-panel-raised text-lr-text" : "text-lr-text-faint hover:text-lr-text"}`}
          >
            Select
          </button>
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          {(Object.keys(TOOL_LABELS) as Array<Exclude<MaskTool, "none">>).map((kind) => (
            <button
              key={kind}
              type="button"
              title={`${TOOL_LABELS[kind]} (${TOOL_SHORTCUTS[kind]})`}
              aria-pressed={activeTool === kind}
              onClick={() => activateTool(kind)}
              className={`flex min-h-[54px] flex-col items-center justify-center gap-1 rounded-lg border px-2 py-2 text-[10px] ${activeTool === kind ? "border-lr-accent bg-lr-selection text-lr-accent" : "border-lr-border-subtle text-lr-text-muted hover:bg-lr-panel-raised hover:text-lr-text"}`}
            >
              <span className="font-mono text-[9px] font-semibold tracking-[0.08em]">
                {kind === "brush" ? "BRS" : kind === "linear-gradient" ? "LIN" : "RAD"}
              </span>
              <span>{TOOL_LABELS[kind]}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <section className="max-h-[212px] overflow-auto border-b border-lr-border-subtle">
          {masks.length === 0 ? (
            <button type="button" onClick={addMask} className="m-3 block rounded-md border border-dashed border-lr-border-subtle px-3 py-3 text-left text-[11px] text-lr-text-muted hover:border-lr-text-dim hover:text-lr-text">
              Choose a tool and paint to add a mask.
            </button>
          ) : (
            <div className="space-y-1 p-2">
              {masks.map((mask, index) => (
                <MaskRow
                  key={mask.id}
                  mask={mask}
                  index={index}
                  count={masks.length}
                  selected={mask.id === selectedMaskId}
                  onSelect={() => selectMask(mask)}
                  onRename={(name) => dispatch({ kind: "rename-mask", maskId: mask.id, name }, "Rename mask")}
                  onEnabled={(enabled) => dispatch({ kind: "set-mask-enabled", maskId: mask.id, enabled }, enabled ? "Enable mask" : "Disable mask")}
                  onInverted={(inverted) => dispatch({ kind: "set-mask-inverted", maskId: mask.id, inverted }, inverted ? "Invert mask" : "Restore mask")}
                  onDuplicate={() => {
                    if (masks.length >= MAX_MASKS) return;
                    const newMaskId = crypto.randomUUID();
                    const newComponentIds = mask.components.map(() => crypto.randomUUID());
                    dispatch({ kind: "duplicate-mask", maskId: mask.id, newMaskId, newComponentIds, index: index + 1 }, "Duplicate mask");
                    setSelectedMask(newMaskId);
                    setSelectedComponent(newComponentIds[0] ?? null);
                  }}
                  onMove={(toIndex) => dispatch({ kind: "move-mask", maskId: mask.id, toIndex }, "Reorder mask")}
                  onDelete={() => {
                    dispatch({ kind: "remove-mask", maskId: mask.id }, "Delete mask");
                    if (mask.id === selectedMaskId) {
                      const next = masks[index + 1] ?? masks[index - 1] ?? null;
                      setSelectedMask(next?.id ?? null);
                      setSelectedComponent(next?.components[0]?.id ?? null);
                    }
                  }}
                />
              ))}
            </div>
          )}
        </section>

        {selectedMask ? (
          <>
            <section className="border-b border-lr-border-subtle">
              <div className="flex items-center justify-between px-4 py-3">
                <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-lr-text-muted">Components</h3>
                <span className="text-[10px] text-lr-text-faint">{selectedMask.name}</span>
              </div>
              <div className="space-y-1 px-3 pb-3">
                {selectedMask.components.map((component) => (
                  <ComponentRow
                    key={component.id}
                    component={component}
                    first={component.id === selectedMask.components[0]?.id}
                    selected={component.id === selectedComponentId}
                    canDelete={selectedMask.components.length > 1}
                    onSelect={() => {
                      setSelectedMask(selectedMask.id);
                      setSelectedComponent(component.id);
                      setTool("none");
                    }}
                    onOperation={(operation) => dispatch({ kind: "set-mask-component-operation", maskId: selectedMask.id, componentId: component.id, operation }, operation === "add" ? "Add component" : "Subtract component")}
                    onDelete={() => {
                      dispatch({ kind: "remove-mask-component", maskId: selectedMask.id, componentId: component.id }, "Delete component");
                      if (component.id === selectedComponentId) {
                        const next = selectedMask.components.find((item) => item.id !== component.id);
                        setSelectedComponent(next?.id ?? null);
                        setTool("none");
                      }
                    }}
                  />
                ))}
              </div>
            </section>

            <section className="border-b border-lr-border-subtle px-4 py-3">
              <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-lr-text-muted">Add component</h3>
              <div className="grid grid-cols-3 gap-1.5">
                {(Object.keys(TOOL_LABELS) as Array<Exclude<MaskTool, "none">>).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    title={`Add ${TOOL_LABELS[kind]} component (${TOOL_SHORTCUTS[kind]})`}
                    disabled={selectedMask.components.length >= MAX_COMPONENTS_PER_MASK}
                    onClick={() => activateTool(kind, true)}
                    className="rounded-md border border-lr-border-subtle px-1.5 py-2 text-[10px] text-lr-text-muted hover:bg-lr-panel-raised hover:text-lr-text disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    + {TOOL_LABELS[kind]}
                  </button>
                ))}
              </div>
            </section>

            {selectedComponent?.kind === "radial-gradient" ? (
              <RadialControls component={selectedComponent} onChange={updateSelectedComponent} />
            ) : null}

            <LocalBasicControls
              mask={selectedMask}
              onChange={(adjustments) => dispatch({ kind: "set-mask-adjustments", maskId: selectedMask.id, adjustments }, "Adjust local Basic")}
              onInteractionStart={beginLocalAdjustment}
              onInteractionEnd={endLocalAdjustment}
            />
          </>
        ) : null}

      </div>

      <div className="flex gap-2 border-t border-lr-border-subtle p-3">
        <button
          type="button"
          disabled={!selectedMask}
          onClick={deleteSelectedMask}
          className="flex-1 rounded-lg border border-lr-border-subtle px-3 py-2 text-xs text-lr-text-muted hover:bg-lr-panel-raised hover:text-lr-text disabled:cursor-not-allowed disabled:opacity-35"
        >
          Delete mask
        </button>
        <button
          type="button"
          onClick={() => {
            setTool("none");
            onDone();
          }}
          className="flex-1 rounded-lg bg-lr-accent px-3 py-2 text-xs font-medium text-[#14202a] hover:bg-lr-accent-hover"
        >
          Done · ↵
        </button>
      </div>
    </aside>
  );
}

function MaskRow({
  mask,
  index,
  count,
  selected,
  onSelect,
  onRename,
  onEnabled,
  onInverted,
  onDuplicate,
  onMove,
  onDelete,
}: {
  mask: LocalMask;
  index: number;
  count: number;
  selected: boolean;
  onSelect: () => void;
  onRename: (name: string) => void;
  onEnabled: (enabled: boolean) => void;
  onInverted: (inverted: boolean) => void;
  onDuplicate: () => void;
  onMove: (index: number) => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(mask.name);

  function commitName() {
    const next = name.trim();
    if (next && next !== mask.name) onRename(next);
    else setName(mask.name);
  }

  return (
    <div className={`group rounded-lg border ${selected ? "border-lr-accent/70 bg-lr-selection/50" : "border-lr-border-subtle bg-transparent hover:border-lr-text-dim hover:bg-lr-panel-raised/70"}`}>
      <div className="flex items-center gap-2.5 px-2 py-2">
        <button
          type="button"
          onClick={onSelect}
          aria-label={`Select ${mask.name}`}
          aria-pressed={selected}
          className="relative h-8 w-8 shrink-0 overflow-hidden rounded-[5px] bg-[#0f0d0c]"
        >
          <span
            aria-hidden
            className={[
              "absolute bg-lr-accent/55",
              mask.components[0]?.kind === "linear-gradient"
                ? "inset-x-0 bottom-0 h-2/3"
                : mask.components[0]?.kind === "radial-gradient"
                  ? "left-1/4 top-1/4 h-1/2 w-1/2 rounded-full"
                  : mask.components[0]?.kind === "ai" && mask.components[0].selector === "sky"
                    ? "inset-x-0 top-0 h-1/2"
                    : "inset-x-1 bottom-1 h-3/5 rounded-full",
              mask.enabled ? "" : "opacity-30",
            ].join(" ")}
          />
        </button>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <input
            aria-label={`Rename ${mask.name}`}
            value={name}
            onChange={(event) => setName(event.target.value)}
            onFocus={onSelect}
            onBlur={commitName}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              }
            }}
            className="min-w-0 bg-transparent text-[11px] text-lr-text outline-none"
          />
          <span className="truncate text-[9px] tracking-[0.04em] text-lr-text-faint">
            {maskSummary(mask)}
          </span>
        </span>
        <span className={`font-mono text-[9px] ${selected ? "text-lr-accent" : "text-lr-text-faint"}`}>
          {adjustmentSummary(mask)}
        </span>
        <SmallButton label={mask.enabled ? "Disable mask" : "Enable mask"} onClick={() => onEnabled(!mask.enabled)}>
          {mask.enabled ? <IconEye className="h-3 w-3" /> : <IconEyeOff className="h-3 w-3" />}
        </SmallButton>
      </div>
      <div className={`items-center justify-end gap-0.5 px-2 pb-1.5 ${selected ? "flex" : "hidden group-hover:flex"}`}>
        <SmallButton label={mask.inverted ? "Restore mask" : "Invert mask"} active={mask.inverted} onClick={() => onInverted(!mask.inverted)}>Inv</SmallButton>
        <SmallButton label="Move mask up" disabled={index === 0} onClick={() => onMove(index - 1)}><IconChevronUp className="h-3 w-3" /></SmallButton>
        <SmallButton label="Move mask down" disabled={index === count - 1} onClick={() => onMove(index + 1)}><IconChevronDown className="h-3 w-3" /></SmallButton>
        <SmallButton label="Duplicate mask" disabled={count >= MAX_MASKS} onClick={onDuplicate}><IconCopy className="h-3 w-3" /></SmallButton>
        <SmallButton label="Delete mask" onClick={onDelete}><IconTrash className="h-3 w-3" /></SmallButton>
      </div>
    </div>
  );
}

function SmallButton({
  label,
  children,
  onClick,
  disabled = false,
  active = false,
}: {
  label: string;
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button type="button" title={label} aria-label={label} disabled={disabled} onClick={(event) => { event.stopPropagation(); onClick(); }} className={`flex h-5 min-w-5 items-center justify-center rounded px-1 text-[9px] ${active ? "bg-lr-accent/20 text-lr-accent" : "text-lr-text-faint hover:bg-lr-panel-raised hover:text-lr-text"} disabled:pointer-events-none disabled:opacity-30`}>
      {children}
    </button>
  );
}

function ComponentRow({
  component,
  first,
  selected,
  canDelete,
  onSelect,
  onOperation,
  onDelete,
}: {
  component: MaskComponent;
  first: boolean;
  selected: boolean;
  canDelete: boolean;
  onSelect: () => void;
  onOperation: (operation: MaskOperation) => void;
  onDelete: () => void;
}) {
  return (
    <div className={`flex items-center gap-1 rounded-md border px-2 py-1.5 ${selected ? "border-lr-accent/70 bg-lr-selection/50" : "border-transparent hover:border-lr-border-subtle"}`}>
      <button type="button" onClick={onSelect} className="min-w-0 flex-1 truncate text-left text-[11px] text-lr-text-muted hover:text-lr-text">{componentLabel(component)}</button>
      <button type="button" title={first ? "The first component must add" : `Change ${componentLabel(component)} operation`} aria-label={first ? "The first component must add" : `Change ${componentLabel(component)} operation`} disabled={first} onClick={() => onOperation(component.operation === "add" ? "subtract" : "add")} className={`rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wide ${component.operation === "add" ? "bg-lr-accent/15 text-lr-accent" : "bg-red-950/50 text-red-200"} disabled:cursor-not-allowed disabled:opacity-70`}>
        {component.operation === "add" ? "Add" : "Subtract"}
      </button>
      <SmallButton label="Delete component" disabled={!canDelete} onClick={onDelete}><IconTrash className="h-3 w-3" /></SmallButton>
    </div>
  );
}

function RadialControls({ component, onChange }: { component: RadialGradientMaskComponent; onChange: (component: RadialGradientMaskComponent) => void }) {
  return (
    <section className="border-b border-lr-border-subtle px-4 py-3">
      <div className="mb-1 flex items-center gap-2">
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-lr-text-muted">Radial gradient</h3>
        <span className="rounded bg-lr-selection px-1.5 py-0.5 font-mono text-[9px] text-lr-accent">R</span>
      </div>
      <p className="mb-2 text-[10px] leading-relaxed text-lr-text-faint">Drag the ellipse on the photo. Use the handles to resize or rotate it.</p>
      <SliderRow label="Radius X" value={component.radiusX} min={0.01} max={1} step={0.01} onChange={(radiusX) => onChange({ ...component, radiusX })} />
      <SliderRow label="Radius Y" value={component.radiusY} min={0.01} max={1} step={0.01} onChange={(radiusY) => onChange({ ...component, radiusY })} />
      <SliderRow label="Rotation" value={component.rotation} min={-180} max={180} step={1} suffix="°" onChange={(rotation) => onChange({ ...component, rotation })} />
      <SliderRow label="Feather" value={component.feather} min={0} max={1} step={0.01} onChange={(feather) => onChange({ ...component, feather })} />
    </section>
  );
}

function LocalBasicControls({
  mask,
  onChange,
  onInteractionStart,
  onInteractionEnd,
}: {
  mask: LocalMask;
  onChange: (adjustments: BasicSettings) => void;
  onInteractionStart: () => void;
  onInteractionEnd: () => void;
}) {
  const basic = mask.adjustments;
  const interaction = { onInteractionStart, onInteractionEnd };
  function update(patch: Partial<BasicSettings>) {
    onChange({ ...basic, ...patch });
  }

  return (
    <>
      <section className="border-b border-lr-border-subtle px-4 py-3">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-lr-text-muted">Light</h3>
          <span className="text-[9px] text-lr-text-faint">Mask only</span>
        </div>
        <SliderRow {...interaction} label="Exposure" value={basic.exposure} min={-5} max={5} step={0.05} onChange={(exposure) => update({ exposure })} />
        <SliderRow {...interaction} label="Contrast" value={basic.contrast} min={-100} max={100} onChange={(contrast) => update({ contrast })} />
        <SliderRow {...interaction} label="Highlights" value={basic.highlights} min={-100} max={100} onChange={(highlights) => update({ highlights })} />
        <SliderRow {...interaction} label="Shadows" value={basic.shadows} min={-100} max={100} onChange={(shadows) => update({ shadows })} />
        <SliderRow {...interaction} label="Whites" value={basic.whites} min={-100} max={100} onChange={(whites) => update({ whites })} />
        <SliderRow {...interaction} label="Blacks" value={basic.blacks} min={-100} max={100} onChange={(blacks) => update({ blacks })} />
      </section>
      <section className="border-b border-lr-border-subtle px-4 py-3">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-lr-text-muted">Color</h3>
          <span className="text-[9px] text-lr-text-faint">Mask only</span>
        </div>
        <SliderRow {...interaction} label="Temp" value={basic.temperature} min={-3000} max={3000} step={50} suffix="K" track={COLOR_SLIDER_TRACKS.temperature} onChange={(temperature) => update({ temperature })} />
        <SliderRow {...interaction} label="Tint" value={basic.tint} min={-150} max={150} track={COLOR_SLIDER_TRACKS.tint} onChange={(tint) => update({ tint })} />
        <SliderRow {...interaction} label="Vibrance" value={basic.vibrance} min={-100} max={100} track={COLOR_SLIDER_TRACKS.vibrance} onChange={(vibrance) => update({ vibrance })} />
        <SliderRow {...interaction} label="Saturation" value={basic.saturation} min={-100} max={100} track={COLOR_SLIDER_TRACKS.saturation} onChange={(saturation) => update({ saturation })} />
      </section>
    </>
  );
}
