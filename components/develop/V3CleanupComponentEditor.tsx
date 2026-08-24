"use client";

import { SliderRow } from "@/components/develop/SliderRow";
import { SectionLabel } from "@/components/develop/V3PanelControls";
import {
  parseCleanupComponent,
  type CleanupComponent,
  type CleanupEllipse,
} from "@/lib/develop/v3/cleanup";

const MIN_RADIUS = 0.001;

interface EllipseDefaults {
  readonly centerX: number;
  readonly centerY: number;
  readonly radiusX: number;
  readonly radiusY: number;
}

function EllipseEditor({
  label,
  ellipse,
  defaults,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly ellipse: CleanupEllipse;
  readonly defaults: EllipseDefaults;
  readonly disabled: boolean;
  readonly onChange: (ellipse: CleanupEllipse) => void;
}) {
  const replace = (patch: Partial<CleanupEllipse>) => {
    onChange({ ...ellipse, ...patch });
  };

  return (
    <div>
      <SectionLabel>{label}</SectionLabel>
      <SliderRow label={`${label} center X`} value={ellipse.center.x} min={0} max={1} step={0.001} resetValue={defaults.centerX} disabled={disabled} onChange={(x) => replace({ center: { ...ellipse.center, x } })} />
      <SliderRow label={`${label} center Y`} value={ellipse.center.y} min={0} max={1} step={0.001} resetValue={defaults.centerY} disabled={disabled} onChange={(y) => replace({ center: { ...ellipse.center, y } })} />
      <SliderRow label={`${label} radius X`} value={ellipse.radiusX} min={MIN_RADIUS} max={1} step={0.001} resetValue={defaults.radiusX} disabled={disabled} onChange={(radiusX) => replace({ radiusX })} />
      <SliderRow label={`${label} radius Y`} value={ellipse.radiusY} min={MIN_RADIUS} max={1} step={0.001} resetValue={defaults.radiusY} disabled={disabled} onChange={(radiusY) => replace({ radiusY })} />
      <SliderRow label={`${label} rotation`} value={ellipse.rotationDegrees} min={-180} max={180} step={0.1} suffix="°" resetValue={0} disabled={disabled} onChange={(rotationDegrees) => replace({ rotationDegrees })} />
    </div>
  );
}

export interface V3CleanupComponentEditorProps {
  readonly component: CleanupComponent;
  readonly onReplace: (component: CleanupComponent) => void;
  readonly disabled?: boolean;
}

export function V3CleanupComponentEditor({
  component,
  onReplace,
  disabled = false,
}: V3CleanupComponentEditorProps) {
  const replace = (candidate: CleanupComponent) => {
    onReplace(parseCleanupComponent(candidate));
  };

  if (component.kind === "red-eye") {
    return (
      <div aria-label="Red-eye component settings">
        <EllipseEditor
          label="Eye bounds"
          ellipse={component.bounds}
          defaults={{ centerX: 0.5, centerY: 0.5, radiusX: 0.06, radiusY: 0.04 }}
          disabled={disabled}
          onChange={(bounds) => replace({ ...component, bounds })}
        />
        <SectionLabel>Red-eye correction</SectionLabel>
        <SliderRow label="Pupil radius" value={component.pupilRadius} min={MIN_RADIUS} max={1} step={0.001} resetValue={0.5} disabled={disabled} onChange={(pupilRadius) => replace({ ...component, pupilRadius })} />
        <SliderRow label="Amount" value={component.amount} min={0} max={1} step={0.01} resetValue={0.5} disabled={disabled} onChange={(amount) => replace({ ...component, amount })} />
        <SliderRow label="Catchlight protection" value={component.catchlightProtection} min={0} max={1} step={0.01} resetValue={0.5} disabled={disabled} onChange={(catchlightProtection) => replace({ ...component, catchlightProtection })} />
      </div>
    );
  }
  const sampledSource = component.source.kind === "sampled"
    ? component.source
    : null;

  return (
    <div aria-label={`${component.mode} repair component settings`}>
      <EllipseEditor
        label="Target"
        ellipse={component.target}
        defaults={{ centerX: 0.5, centerY: 0.5, radiusX: 0.08, radiusY: 0.08 }}
        disabled={disabled}
        onChange={(target) => replace({ ...component, target })}
      />
      <SectionLabel>Repair strength</SectionLabel>
      <SliderRow label="Feather" value={component.feather} min={0} max={1} step={0.01} resetValue={0.5} disabled={disabled} onChange={(feather) => replace({ ...component, feather })} />
      <SliderRow label="Opacity" value={component.opacity} min={0} max={1} step={0.01} resetValue={1} disabled={disabled} onChange={(opacity) => replace({ ...component, opacity })} />
      {sampledSource ? (
        <EllipseEditor
          label="Source"
          ellipse={sampledSource.region}
          defaults={{ centerX: 0.35, centerY: 0.35, radiusX: 0.08, radiusY: 0.08 }}
          disabled={disabled}
          onChange={(region) => replace({
            ...component,
            source: { ...sampledSource, region },
          })}
        />
      ) : null}
    </div>
  );
}
