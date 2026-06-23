"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
  type RefObject,
} from "react";
import { measureContentWidth } from "@/lib/library/grid-layout";

export function useGridContainerWidth(
  parentRef: RefObject<HTMLElement | null>,
  remeasureKey: unknown,
): number {
  const [containerWidth, setContainerWidth] = useState(0);

  const updateWidth = useCallback((element: HTMLElement) => {
    const width = measureContentWidth(element);
    if (width > 0) {
      setContainerWidth(width);
    }
  }, []);

  useLayoutEffect(() => {
    const element = parentRef.current;
    if (element) {
      updateWidth(element);
    }
  }, [parentRef, updateWidth, remeasureKey]);

  useEffect(() => {
    const element = parentRef.current;
    if (!element) {
      return;
    }

    const observer = new ResizeObserver(() => updateWidth(element));
    observer.observe(element);

    return () => observer.disconnect();
  }, [parentRef, updateWidth]);

  return containerWidth;
}
