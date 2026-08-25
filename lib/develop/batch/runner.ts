import type { EntryId } from "../../catalog/ids.ts";
import type { DevelopRevisionId } from "../history.ts";
import type { DevelopBatchId, DevelopBatchReceipt, DevelopBatchReceiptItem } from "./domain.ts";

export interface DevelopBatchRunnerAdapter {
  readonly load: (batchId: DevelopBatchId) => Promise<DevelopBatchReceipt>;
  readonly markActive: (batchId: DevelopBatchId, position: number) => Promise<void>;
  readonly executeAndPersist: (receipt: DevelopBatchReceipt, item: DevelopBatchReceiptItem) => Promise<void>;
  readonly cancelQueued: (batchId: DevelopBatchId) => Promise<void>;
}

export async function runDurableDevelopBatch(
  batchId: DevelopBatchId,
  adapter: DevelopBatchRunnerAdapter,
): Promise<DevelopBatchReceipt> {
  while (true) {
    const receipt = await adapter.load(batchId);
    if (receipt.cancellationRequested) {
      await adapter.cancelQueued(batchId);
      return adapter.load(batchId);
    }
    const item = receipt.items.find((candidate) => candidate.state.kind === "queued");
    if (!item) return receipt;
    await adapter.markActive(batchId, item.position);
    const activeReceipt = await adapter.load(batchId);
    const active = activeReceipt.items[item.position];
    if (!active || active.state.kind !== "active") throw new Error("Develop batch active item is missing.");
    await adapter.executeAndPersist(activeReceipt, active);
  }
}

export function previousCommittedEntry(input: {
  readonly currentEntryId: EntryId;
  readonly committed: readonly { readonly entryId: EntryId; readonly revisionId: DevelopRevisionId; readonly committedAt: number }[];
}): { readonly entryId: EntryId; readonly revisionId: DevelopRevisionId } | null {
  const previous = [...input.committed]
    .filter((candidate) => candidate.entryId !== input.currentEntryId)
    .sort((left, right) => right.committedAt - left.committedAt || left.entryId.localeCompare(right.entryId))[0];
  return previous ? { entryId: previous.entryId, revisionId: previous.revisionId } : null;
}
