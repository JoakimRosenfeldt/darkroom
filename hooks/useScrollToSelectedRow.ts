import { useLayoutEffect, useRef } from "react";
import type { Virtualizer } from "@tanstack/react-virtual";

interface UseScrollToSelectedRowOptions {
  layoutReady: boolean;
  selectedRowIndex: number;
  virtualizer: Virtualizer<HTMLDivElement, Element>;
  /** Rows jumped in one step before smooth scroll is used. */
  smoothRowThreshold?: number;
}

export function useScrollToSelectedRow({
  layoutReady,
  selectedRowIndex,
  virtualizer,
  smoothRowThreshold = 3,
}: UseScrollToSelectedRowOptions): void {
  const previousRowIndexRef = useRef(-1);
  const virtualizerRef = useRef(virtualizer);
  virtualizerRef.current = virtualizer;

  useLayoutEffect(() => {
    if (!layoutReady || selectedRowIndex < 0) {
      return;
    }

    const previousRowIndex = previousRowIndexRef.current;
    previousRowIndexRef.current = selectedRowIndex;

    const rowDistance =
      previousRowIndex < 0
        ? 0
        : Math.abs(selectedRowIndex - previousRowIndex);

    virtualizerRef.current.scrollToIndex(selectedRowIndex, {
      align: "auto",
      behavior: rowDistance >= smoothRowThreshold ? "smooth" : "instant",
    });
  }, [layoutReady, selectedRowIndex, smoothRowThreshold]);
}
