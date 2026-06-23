export type GridDirection = "left" | "right" | "up" | "down";

function findPosition(
  rows: string[][],
  entryId: string,
): { rowIndex: number; colIndex: number } | null {
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const colIndex = rows[rowIndex]?.indexOf(entryId) ?? -1;
    if (colIndex >= 0) {
      return { rowIndex, colIndex };
    }
  }
  return null;
}

export function navigateGridRows(
  rows: string[][],
  currentId: string | null,
  direction: GridDirection,
): string | null {
  if (rows.length === 0) {
    return null;
  }

  const position = currentId ? findPosition(rows, currentId) : null;

  if (!position) {
    return rows[0]?.[0] ?? null;
  }

  const { rowIndex, colIndex } = position;
  const currentRow = rows[rowIndex];

  if (!currentRow) {
    return null;
  }

  switch (direction) {
    case "left": {
      if (colIndex > 0) {
        return currentRow[colIndex - 1] ?? null;
      }
      if (rowIndex === 0) {
        return currentId;
      }
      const targetRow = rows[rowIndex - 1];
      if (!targetRow || targetRow.length === 0) {
        return currentId;
      }
      return targetRow[targetRow.length - 1] ?? null;
    }
    case "right": {
      if (colIndex < currentRow.length - 1) {
        return currentRow[colIndex + 1] ?? null;
      }
      if (rowIndex >= rows.length - 1) {
        return currentId;
      }
      const targetRow = rows[rowIndex + 1];
      if (!targetRow || targetRow.length === 0) {
        return currentId;
      }
      return targetRow[0] ?? null;
    }
    case "up": {
      if (rowIndex === 0) {
        return currentId;
      }
      const targetRow = rows[rowIndex - 1];
      if (!targetRow || targetRow.length === 0) {
        return currentId;
      }
      return targetRow[Math.min(colIndex, targetRow.length - 1)] ?? null;
    }
    case "down": {
      if (rowIndex >= rows.length - 1) {
        return currentId;
      }
      const targetRow = rows[rowIndex + 1];
      if (!targetRow || targetRow.length === 0) {
        return currentId;
      }
      return targetRow[Math.min(colIndex, targetRow.length - 1)] ?? null;
    }
  }
}
