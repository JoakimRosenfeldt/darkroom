"use client";

import type { ReactNode } from "react";

export function PanelSection({
  title,
  onReset,
  children,
}: {
  title: string;
  onReset?: () => void;
  children: ReactNode;
}) {
  return (
    <section className="border-b border-lr-border-subtle px-4 pb-[18px] pt-3.5">
      <div className="mb-2.5 flex items-center gap-2">
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-lr-text-muted">
          {title}
        </h3>
        <div className="flex-1" />
        {onReset ? (
          <button
            type="button"
            onClick={onReset}
            className="text-[10px] text-lr-text-faint hover:text-lr-text"
          >
            Reset
          </button>
        ) : null}
      </div>
      {children}
    </section>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <h4 className="mb-1.5 mt-3 text-[10px] font-medium text-lr-text-muted first:mt-0">
      {children}
    </h4>
  );
}

export function ToggleRow({
  label,
  checked,
  disabled = false,
  detail,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  detail?: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label
      className={`flex min-h-8 items-center gap-2 py-1 text-xs ${disabled ? "opacity-45" : ""}`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="size-3.5 accent-lr-accent"
      />
      <span className="text-lr-text-muted">{label}</span>
      {detail ? (
        <span className="ml-auto max-w-[168px] text-right text-[10px] leading-4 text-lr-text-faint">
          {detail}
        </span>
      ) : null}
    </label>
  );
}

export function SelectRow({
  label,
  value,
  disabled = false,
  children,
  onChange,
}: {
  label: string;
  value: string;
  disabled?: boolean;
  children: ReactNode;
  onChange: (value: string) => void;
}) {
  return (
    <label className={`grid grid-cols-[92px_1fr] items-center gap-2.5 py-1 text-xs ${disabled ? "opacity-45" : ""}`}>
      <span className="text-lr-text-muted">{label}</span>
      <select
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="min-w-0 rounded-md border border-lr-border-subtle bg-lr-panel-raised px-2 py-1.5 text-[11px] text-lr-text outline-none focus:border-lr-text-dim"
      >
        {children}
      </select>
    </label>
  );
}

export function StatusCard({
  title,
  children,
  tone = "neutral",
}: {
  title: string;
  children: ReactNode;
  tone?: "neutral" | "warning" | "danger";
}) {
  const color = tone === "danger"
    ? "text-lr-danger"
    : tone === "warning"
      ? "text-lr-accent"
      : "text-lr-text-muted";
  return (
    <div className="rounded-[7px] border border-lr-border-subtle bg-lr-panel-raised/55 p-2.5">
      <p className={`text-[10px] font-semibold ${color}`}>{title}</p>
      <div className="mt-1 text-[10px] leading-4 text-lr-text-faint">
        {children}
      </div>
    </div>
  );
}

export function ActionButton({
  children,
  onClick,
  disabled = false,
  pressed,
  title,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={`rounded-[7px] border px-2.5 py-1.5 text-[11px] transition disabled:pointer-events-none disabled:opacity-40 ${
        pressed
          ? "border-lr-text-dim bg-lr-panel-raised text-lr-text"
          : "border-lr-border-subtle text-lr-text-muted hover:bg-lr-panel-raised hover:text-lr-text"
      }`}
    >
      {children}
    </button>
  );
}
