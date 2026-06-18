const MAX_CONCURRENT_ASPECT_LOADS = 8;

let active = 0;
let sequence = 0;

interface QueueItem {
  priority: number;
  sequence: number;
  start: () => void;
}

const waitQueue: QueueItem[] = [];

function nextQueuedItem(): QueueItem | undefined {
  let bestIndex = -1;

  for (let index = 0; index < waitQueue.length; index += 1) {
    const candidate = waitQueue[index];
    if (
      bestIndex === -1 ||
      candidate.priority > waitQueue[bestIndex].priority ||
      (candidate.priority === waitQueue[bestIndex].priority &&
        candidate.sequence < waitQueue[bestIndex].sequence)
    ) {
      bestIndex = index;
    }
  }

  if (bestIndex === -1) {
    return undefined;
  }

  const [item] = waitQueue.splice(bestIndex, 1);
  return item;
}

export function runWithAspectLoadLimit<T>(
  operation: () => Promise<T>,
  priority = 0,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const item: QueueItem = {
      priority,
      sequence,
      start: () => {
        active += 1;
        operation()
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            const next = nextQueuedItem();
            if (next) {
              next.start();
            }
          });
      },
    };
    sequence += 1;

    if (active < MAX_CONCURRENT_ASPECT_LOADS) {
      item.start();
      return;
    }

    waitQueue.push(item);
  });
}
