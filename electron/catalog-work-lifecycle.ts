export type CatalogWorkKind = "manual" | "auto" | "fingerprint";

export interface CatalogWorkToken {
  readonly kind: CatalogWorkKind;
  readonly isCancelled: () => boolean;
}

export interface CatalogWorkLifecycleOptions {
  readonly drainBindings?: () => Promise<void>;
}

type LifecyclePhase = "open" | "transitioning" | "shutdown";

interface TrackedWork {
  readonly token: CatalogWorkToken;
  readonly settled: Promise<void>;
  cancel(): void;
}

const CLOSED_MESSAGE = "Catalog work is unavailable during a catalog transition.";
const SHUTDOWN_MESSAGE = "Catalog work is unavailable during application shutdown.";

export class CatalogWorkLifecycle {
  private readonly drainBindings: () => Promise<void>;
  private readonly active = new Set<TrackedWork>();
  private phase: LifecyclePhase = "open";
  private transitionTail: Promise<void> = Promise.resolve();
  private pendingTransitions = 0;
  private shutdownPromise: Promise<void> | null = null;

  public constructor(options: CatalogWorkLifecycleOptions = {}) {
    this.drainBindings = options.drainBindings ?? (async () => undefined);
  }

  public assertOpen(): void {
    if (this.phase === "shutdown") throw new Error(SHUTDOWN_MESSAGE);
    if (this.phase !== "open") throw new Error(CLOSED_MESSAGE);
  }

  public track<T>(kind: CatalogWorkKind, task: (token: CatalogWorkToken) => Promise<T>): Promise<T> {
    this.assertOpen();
    let cancelled = false;
    const token: CatalogWorkToken = {
      kind,
      isCancelled: () => cancelled,
    };
    let settledResolve: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      settledResolve = resolve;
    });
    const work: TrackedWork = {
      token,
      settled,
      cancel: () => {
        cancelled = true;
      },
    };
    this.active.add(work);

    let result: Promise<T>;
    try {
      result = task(token);
    } catch (error) {
      result = Promise.reject(error);
    }
    void Promise.resolve(result).then(
      () => {
        settledResolve();
        this.active.delete(work);
      },
      () => {
        settledResolve();
        this.active.delete(work);
      },
    );
    return result;
  }

  public transition<T>(task: () => Promise<T>, recover: () => Promise<void>): Promise<T> {
    if (this.phase === "shutdown") return Promise.reject(new Error(SHUTDOWN_MESSAGE));
    this.phase = "transitioning";
    this.pendingTransitions += 1;

    const execute = async (): Promise<T> => {
      let value!: T;
      let taskFailure: unknown = null;
      let taskFailed = false;
      try {
        await this.drain();
        value = await task();
      } catch (error) {
        taskFailed = true;
        taskFailure = error;
      }

      this.pendingTransitions -= 1;
      let recoveryFailure: unknown = null;
      let recoveryFailed = false;
      if (this.canRecover()) {
        try {
          await recover();
        } catch (error) {
          recoveryFailed = true;
          recoveryFailure = error;
        } finally {
          if (this.canRecover()) {
            this.phase = "open";
          }
        }
      }

      if (taskFailed) throw taskFailure;
      if (recoveryFailed) throw recoveryFailure;
      return value;
    };

    const result = this.transitionTail.then(execute, execute);
    this.transitionTail = result.then(() => undefined, () => undefined);
    return result;
  }

  public shutdown(): Promise<void> {
    if (this.shutdownPromise !== null) return this.shutdownPromise;
    this.phase = "shutdown";
    this.shutdownPromise = this.transitionTail.then(
      () => this.drain(),
      () => this.drain(),
    );
    return this.shutdownPromise;
  }

  private async drain(): Promise<void> {
    while (this.active.size > 0) {
      const pending = [...this.active];
      for (const work of pending) work.cancel();
      await Promise.all(pending.map((work) => work.settled));
    }
    await this.drainBindings();
  }

  private canRecover(): boolean {
    return this.pendingTransitions === 0 && this.phase !== "shutdown";
  }
}
