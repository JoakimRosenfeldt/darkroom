import type { VirtualItem } from "@tanstack/react-virtual";

interface VisibleRow {
  height: number;
  entryIds: string[];
}

export function collectVisibleEntryIds(
  scrollElement: HTMLElement,
  virtualItems: VirtualItem[],
  rows: VisibleRow[],
  selectedEntryId?: string | null,
): string[] {
  const scrollCenter = scrollElement.scrollTop + scrollElement.clientHeight / 2;
  const ranked: Array<{ id: string; distance: number }> = [];

  for (const virtualRow of virtualItems) {
    const row = rows[virtualRow.index];
    if (!row) {
      continue;
    }

    const rowCenter = virtualRow.start + row.height / 2;
    const distance = Math.abs(rowCenter - scrollCenter);

    for (const id of row.entryIds) {
      ranked.push({ id, distance });
    }
  }

  ranked.sort((a, b) => a.distance - b.distance);

  const ids: string[] = [];
  if (selectedEntryId) {
    ids.push(selectedEntryId);
  }

  for (const item of ranked) {
    if (!ids.includes(item.id)) {
      ids.push(item.id);
    }
  }

  return ids;
}
