import type { XmpProps } from "@/lib/develop/types";

export function numberProp(
  props: XmpProps,
  key: string,
): number | null {
  const prop = props[key];
  const value = typeof prop === "string" ? Number(prop) : Number.NaN;
  return Number.isFinite(value) ? value : null;
}
