export function numberProp(
  props: Record<string, string>,
  key: string,
): number | null {
  const value = Number(props[key]);
  return Number.isFinite(value) ? value : null;
}
