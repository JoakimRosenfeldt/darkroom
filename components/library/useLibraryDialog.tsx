"use client";

import { useCallback, useRef, useState } from "react";

interface DialogOption {
  readonly label: string;
  readonly value: string;
}

interface TextDialogRequest {
  readonly kind: "text";
  readonly title: string;
  readonly label: string;
  readonly initialValue: string;
  readonly confirmLabel: string;
  readonly options?: readonly DialogOption[];
}

interface ConfirmDialogRequest {
  readonly kind: "confirm";
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
  readonly danger: boolean;
}

type DialogRequest = TextDialogRequest | ConfirmDialogRequest;

export interface RequestTextOptions {
  readonly title: string;
  readonly label?: string;
  readonly initialValue?: string;
  readonly confirmLabel?: string;
  readonly options?: readonly DialogOption[];
}

export interface RequestConfirmationOptions {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel?: string;
  readonly danger?: boolean;
}

export interface LibraryDialogController {
  readonly requestText: (options: RequestTextOptions) => Promise<string | null>;
  readonly requestConfirmation: (options: RequestConfirmationOptions) => Promise<boolean>;
  readonly element: React.ReactNode;
}

export function useLibraryDialog(): LibraryDialogController {
  const [request, setRequest] = useState<DialogRequest | null>(null);
  const resolverRef = useRef<((value: string | null) => void) | null>(null);

  const finish = useCallback((value: string | null) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setRequest(null);
    resolve?.(value);
  }, []);

  const requestText = useCallback((options: RequestTextOptions) => {
    resolverRef.current?.(null);
    setRequest({
      kind: "text",
      title: options.title,
      label: options.label ?? options.title,
      initialValue: options.initialValue ?? options.options?.[0]?.value ?? "",
      confirmLabel: options.confirmLabel ?? "Save",
      options: options.options,
    });
    return new Promise<string | null>((resolve) => {
      resolverRef.current = resolve;
    });
  }, []);

  const requestConfirmation = useCallback((options: RequestConfirmationOptions) => {
    resolverRef.current?.(null);
    setRequest({
      kind: "confirm",
      title: options.title,
      message: options.message,
      confirmLabel: options.confirmLabel ?? "Confirm",
      danger: options.danger ?? false,
    });
    return new Promise<boolean>((resolve) => {
      resolverRef.current = (value) => resolve(value === "confirmed");
    });
  }, []);

  return {
    requestText,
    requestConfirmation,
    element: request ? <LibraryDialog request={request} onFinish={finish} /> : null,
  };
}

function LibraryDialog({
  request,
  onFinish,
}: {
  request: DialogRequest;
  onFinish: (value: string | null) => void;
}) {
  const [value, setValue] = useState(request.kind === "text" ? request.initialValue : "");

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onFinish(null);
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="library-dialog-title"
        className="w-full max-w-sm rounded-xl border border-lr-border bg-lr-panel-raised p-4 shadow-2xl"
        onSubmit={(event) => {
          event.preventDefault();
          onFinish(request.kind === "confirm" ? "confirmed" : value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") onFinish(null);
        }}
      >
        <h2 id="library-dialog-title" className="text-sm font-semibold text-lr-text">
          {request.title}
        </h2>
        {request.kind === "confirm" ? (
          <p className="mt-2 text-xs leading-5 text-lr-text-muted">{request.message}</p>
        ) : (
          <label className="mt-3 block text-xs text-lr-text-muted">
            {request.label}
            {request.options ? (
              <select
                autoFocus
                value={value}
                onChange={(event) => setValue(event.target.value)}
                className="mt-1.5 h-9 w-full rounded-md border border-lr-border bg-lr-panel px-2 text-sm text-lr-text outline-none focus:border-lr-accent"
              >
                {request.options.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            ) : (
              <input
                autoFocus
                value={value}
                onChange={(event) => setValue(event.target.value)}
                className="mt-1.5 h-9 w-full rounded-md border border-lr-border bg-lr-panel px-2 text-sm text-lr-text outline-none focus:border-lr-accent"
              />
            )}
          </label>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => onFinish(null)}
            className="rounded-md border border-lr-border-subtle px-3 py-1.5 text-xs text-lr-text-muted hover:bg-lr-panel-hover hover:text-lr-text"
          >
            Cancel
          </button>
          <button
            type="submit"
            className={`rounded-md px-3 py-1.5 text-xs text-white ${request.kind === "confirm" && request.danger ? "bg-red-700 hover:bg-red-600" : "bg-lr-accent hover:brightness-110"}`}
          >
            {request.confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
