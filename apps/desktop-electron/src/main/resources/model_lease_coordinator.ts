import type { LocalModelBundleId } from "../../shared/contracts";

export class ModelBusyError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "ModelBusyError";
  }
}

export interface ModelLease {
  readonly id: string;
  readonly bundleId: LocalModelBundleId;
  readonly generation: number;
  release(): void;
}

/** One Main-owned admission gate for Workers, tasks, mutations and migration. */
export class ModelLeaseCoordinator {
  private nextLease = 0;
  private readonly leases = new Map<
    string,
    { bundleId: LocalModelBundleId; generation: number }
  >();
  private mutation: string | null = null;
  private processingTasks = 0;
  private pendingProcessingTasks = 0;
  private readonly listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish(): void {
    for (const listener of this.listeners) listener();
  }

  synchronizeProcessingTasks(count: number): void {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error("processing task count is invalid");
    }
    if (this.pendingProcessingTasks === count) return;
    this.pendingProcessingTasks = count;
    this.publish();
  }

  acquire(bundleId: LocalModelBundleId, generation: number): ModelLease {
    if (this.mutation) {
      throw new ModelBusyError("本地模型正在变更，请稍后重试");
    }
    const id = `lease-${++this.nextLease}`;
    this.leases.set(id, { bundleId, generation });
    this.publish();
    let released = false;
    return Object.freeze({
      id,
      bundleId,
      generation,
      release: () => {
        if (released) return;
        released = true;
        this.leases.delete(id);
        this.publish();
      },
    });
  }

  beginProcessingTask(): () => void {
    if (this.mutation) {
      throw new ModelBusyError("本地模型正在变更，请稍后重试");
    }
    this.processingTasks += 1;
    this.publish();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.processingTasks = Math.max(0, this.processingTasks - 1);
      this.publish();
    };
  }

  beginMutation(
    kind: string,
    options: { migration?: boolean } = {},
  ): () => void {
    if (this.mutation) {
      throw new ModelBusyError("已有本地模型操作正在进行");
    }
    if (
      this.leases.size > 0 ||
      this.processingTasks > 0 ||
      this.pendingProcessingTasks > 0
    ) {
      throw new ModelBusyError("模型正在被处理任务使用，请在任务结束后重试");
    }
    this.mutation = options.migration ? `migration:${kind}` : kind;
    this.publish();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.mutation === (options.migration ? `migration:${kind}` : kind)) {
        this.mutation = null;
        this.publish();
      }
    };
  }

  async beginMutationWhenIdle(kind: string): Promise<() => void> {
    try {
      return this.beginMutation(kind);
    } catch (error) {
      if (!(error instanceof ModelBusyError)) throw error;
    }
    return await new Promise<() => void>((resolve, reject) => {
      const unsubscribe = this.subscribe(() => {
        try {
          const release = this.beginMutation(kind);
          unsubscribe();
          resolve(release);
        } catch (error) {
          if (!(error instanceof ModelBusyError)) {
            unsubscribe();
            reject(error);
          }
        }
      });
    });
  }

  assertPublicationAllowed(): void {
    if (
      this.leases.size > 0 ||
      this.processingTasks > 0 ||
      this.pendingProcessingTasks > 0
    ) {
      throw new ModelBusyError("模型正在使用中，安装将在任务结束后继续");
    }
    if (this.mutation?.startsWith("migration:")) {
      throw new ModelBusyError("模型目录正在迁移");
    }
  }

  get snapshot() {
    return Object.freeze({
      leaseCount: this.leases.size,
      processingTaskCount: Math.max(
        this.processingTasks,
        this.pendingProcessingTasks,
      ),
      mutation: this.mutation,
      idle:
        this.leases.size === 0 &&
        this.processingTasks === 0 &&
        this.pendingProcessingTasks === 0 &&
        this.mutation === null,
    });
  }
}
